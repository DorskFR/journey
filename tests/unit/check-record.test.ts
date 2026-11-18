import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { journeyOk, runLine, unstableLines, unstableTargets } from '../../src/cli/check.js';
import {
	checkVariantFilter,
	envVars,
	journeysDir,
	type LoadedConfig,
	parseVariantFilter,
	selectById,
} from '../../src/cli/config.js';
import { parseArgv, unknownFlags } from '../../src/cli/main.js';
import { finishHar, fromPayload, recordOptions, replaySnippet } from '../../src/cli/record.js';
import { type Config, compile, type IR } from '../../src/index.js';

const ir: IR = compile({
	id: 'pick',
	route: '/',
	steps: [
		{ id: 'start', target: 'start', do: { kind: 'click' } },
		{ id: 'like', target: { within: 'notes/note[#0]', css: '.like' }, do: { kind: 'click' } },
		{ id: 'save', target: { role: 'button', name: 'Save' }, do: { kind: 'click' } },
	],
});

const loaded = (config: Config, dir = '/p'): LoadedConfig => ({
	config,
	dir,
	path: join(dir, 'journey.config.ts'),
});

test('strict check names every unstable target once per journey, with its step and reason', () => {
	const unstable = unstableTargets(ir);
	expect(unstable).toEqual([
		{ step: 'like', health: 'fragile', target: '{"within":"notes/note[#0]","css":".like"}' },
		{ step: 'save', health: 'fallback', target: '{"role":"button","name":"Save"}' },
	]);
	const health = { id: 'pick', targets: { stable: 1, fallback: 1, fragile: 1 }, unstable };
	const run = { variant: { viewport: 'desktop' }, ok: true, failures: [] };
	expect(runLine(health, run, true)).toBe(
		'✗ pick [viewport=desktop] fallback 1 fragile 1 strict: 2 unstable targets',
	);
	expect(runLine(health, run, false)).toBe('✓ pick [viewport=desktop] fallback 1 fragile 1');
	expect(unstableLines(health, true)).toEqual([
		'  step like: fragile {"within":"notes/note[#0]","css":".like"}',
		'  step save: fallback {"role":"button","name":"Save"}',
	]);
	expect(unstableLines(health, false)).toEqual([]);
	expect(journeyOk({ ...health, file: 'x', runs: [run] }, true)).toBe(false);
	expect(journeyOk({ ...health, file: 'x', runs: [run] }, false)).toBe(true);
});

test('a failed run names the step it failed at', () => {
	const health = { id: 'pick', targets: { stable: 3, fallback: 0, fragile: 0 }, unstable: [] };
	const run = {
		variant: { viewport: 'mobile', theme: 'dark' },
		ok: false,
		failures: [{ step: 'save', error: 'timeout\nafter 500 ms' }],
	};
	expect(runLine(health, run, true)).toBe(
		'✗ pick [viewport=mobile theme=dark] fallback 0 fragile 0 step save: timeout; after 500 ms',
	);
});

test('commands reject options they do not take, and value options without a value', () => {
	expect(unknownFlags(parseArgv(['check', '--strcit']))).toMatch(
		/^journey check: unknown option --strcit, expected one of: --strict, --json/,
	);
	expect(unknownFlags(parseArgv(['check', '--strict', '--json', '--variant', 'a=b']))).toBe(
		undefined,
	);
	expect(unknownFlags(parseArgv(['book', '--strict']))).toMatch(
		/journey book: unknown option --strict/,
	);
	expect(unknownFlags(parseArgv(['record', 'http://x', '--no-har', '--viewport', 'm']))).toBe(
		undefined,
	);
	expect(unknownFlags(parseArgv(['compile', '-x']))).toMatch(/unknown option -x/);
	expect(() => parseArgv(['check', '--config'])).toThrow('journey: --config needs a value');
	expect(() => parseArgv(['check', '--config', '--strict'])).toThrow(/--config needs a value/);
	expect(parseArgv(['check', '--config=a.ts']).flags.config).toBe('a.ts');
});

test('a malformed JOURNEY_VARS names the variable', () => {
	expect(() => envVars('{bad')).toThrow(/^journey: JOURNEY_VARS is not valid JSON: /);
	expect(envVars('{"a":1}')).toEqual({ a: '1' });
});

test('check scopes by id and variant, and says which ids and values exist', () => {
	const entries = [{ ir: { ...ir, id: 'a' } }, { ir: { ...ir, id: 'b' } }];
	expect(selectById(entries, [], 'check')).toBe(entries);
	expect(selectById(entries, ['b'], 'check').map((e) => e.ir.id)).toEqual(['b']);
	expect(() => selectById(entries, ['b', 'zz'], 'check')).toThrow(
		'journey check: "zz" not among the configured journeys: a, b',
	);
	const filter = parseVariantFilter('viewport=mobile,viewport=desktop', 'check');
	expect(filter).toEqual({ viewport: ['mobile', 'desktop'] });
	expect(() => parseVariantFilter('mobile', 'check')).toThrow(/^journey check: --variant expects/);
	const matrix = [[{ viewport: 'desktop' }, { viewport: 'mobile' }]];
	expect(() => checkVariantFilter(filter, matrix, 'check')).not.toThrow();
	expect(() => checkVariantFilter({ viewport: ['tablet'] }, matrix, 'check')).toThrow(
		'journey check: unknown viewport "tablet", expected one of: desktop, mobile',
	);
});

test('record writes where the config keeps its journeys', () => {
	expect(journeysDir(loaded({}))).toBe('/p/journeys');
	expect(journeysDir(loaded({ journeys: 'e2e/flows/*.journey.ts' }))).toBe('/p/e2e/flows');
	expect(journeysDir(loaded({ journeys: ['src/**/*.journey.ts'] }))).toBe('/p/src');
	expect(journeysDir(loaded({ journeys: '*.journey.ts' }))).toBe('/p');
	expect(journeysDir(loaded({ journeys: 'flows/{a,b}/*.ts' }))).toBe('/p/flows');
});

test('record takes its url, directories and window size from the config', () => {
	const config: Config = {
		app: { url: 'http://localhost:5173/app/' },
		journeys: 'flows/*.journey.ts',
		variants: { viewport: { tablet: { width: 800, height: 1000 }, desktop: {} } },
	};
	const opts = recordOptions(parseArgv(['record']), loaded(config));
	expect(opts).toMatchObject({
		url: 'http://localhost:5173/app/',
		dir: '/p/flows',
		secrets: '/p/.journey',
		viewport: { width: 800, height: 1000 },
		base: '/p',
	});
	expect(recordOptions(parseArgv(['record', '/settings']), loaded(config)).url).toBe(
		'http://localhost:5173/settings',
	);
	expect(
		recordOptions(parseArgv(['record', '--viewport', 'mobile']), loaded(config)).viewport,
	).toEqual({ width: 390, height: 844 });
	expect(() => recordOptions(parseArgv(['record', '--viewport', 'tv']), loaded(config))).toThrow(
		/viewport "tv" has no size, expected one of: desktop, mobile, tablet/,
	);
	const bare = recordOptions(parseArgv(['record', 'http://x']));
	expect(bare.viewport).toBe(null);
	expect(() => recordOptions(parseArgv(['record']))).toThrow(/start url is required/);
});

test('every export of a session gets its own scrubbed HAR, and the raw one is removed', () => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-har-'));
	try {
		const opts = {
			url: 'http://x',
			dir: join(dir, 'journeys'),
			secrets: join(dir, '.journey'),
			har: true,
			storageState: false,
			headless: true,
			base: dir,
		};
		const raw = join(dir, 'raw.har');
		const har = {
			log: {
				entries: [{ request: { headers: [{ name: 'Cookie', value: 'sid=1' }] }, response: {} }],
			},
		};
		writeFileSync(raw, JSON.stringify(har));
		const one = fromPayload({ ir: { ...ir, id: 'one' } });
		const two = fromPayload({ ir: { ...ir, id: 'two' } });
		expect(finishHar(raw, [one, two], opts)).toEqual([
			join(dir, 'journeys', 'fixtures', 'one.har'),
			join(dir, 'journeys', 'fixtures', 'two.har'),
		]);
		for (const id of ['one', 'two']) {
			const written = readFileSync(join(dir, 'journeys', 'fixtures', `${id}.har`), 'utf8');
			expect(written).not.toContain('sid=1');
		}
		expect(existsSync(raw)).toBe(false);

		writeFileSync(raw, JSON.stringify(har));
		expect(finishHar(raw, [], opts)).toEqual([]);
		expect(existsSync(raw)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('record prints the fixture to paste so the journey replays from its HAR', () => {
	const opts = {
		url: 'http://x',
		dir: '/p/journeys',
		secrets: '/p/.journey',
		har: true,
		storageState: true,
		headless: true,
		base: '/p',
	};
	expect(replaySnippet(['login', 'buy'], opts)).toEqual([
		'journey record: to replay offline, add to the config:',
		'\tfixtures: {',
		"\t\t'login': { har: 'journeys/fixtures/login.har', storageState: '.journey/login.storage.json' },",
		"\t\t'buy': { har: 'journeys/fixtures/buy.har', storageState: '.journey/buy.storage.json' },",
		'\t},',
		"and to each journey: fixture: 'login', fixture: 'buy'",
	]);
	expect(replaySnippet(['login'], { ...opts, har: false, storageState: false })).toEqual([]);
	expect(replaySnippet([], opts)).toEqual([]);
});
