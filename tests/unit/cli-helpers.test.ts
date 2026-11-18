import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { placementOf, presenterOf, selectJourneys, wantsVideo } from '../../src/cli/book.js';
import { healthCounts, journeyOk, reportOk, targetHealth } from '../../src/cli/check.js';
import {
	envVars,
	importDefault,
	type LoadedConfig,
	matchesFilter,
	parseVariantFilter,
	variantKey,
	variantLabel,
	variantMatrix,
	variantNames,
	viewports,
	withEnvVars,
} from '../../src/cli/config.js';
import type { LoadedJourney } from '../../src/cli/load.js';
import { flagMillis, flagString, parseArgv } from '../../src/cli/main.js';
import { combinations, renderPagesIndex } from '../../src/cli/pages.js';
import { escapeHtml, prefixFiles } from '../../src/cli/report.js';
import type { Config, IR, IRStep } from '../../src/core/types.js';
import { CROP_PADDING, clipRect, retryScreenshot } from '../../src/playwright/capture.js';
import { BUILTIN_VIEWPORTS, errorLine, startUrl } from '../../src/playwright/driver.js';
import { resolveFrom, storageStatePath } from '../../src/playwright/fixtures.js';
import { failureMessage } from '../../src/playwright/index.js';

function ir(steps: Partial<IRStep>[] = [], extra: Partial<IR> = {}): IR {
	return {
		id: 'j',
		version: 1,
		route: '/',
		level: 'smoke',
		steps: steps.map((s, i) => ({
			id: `s${i}`,
			do: { kind: 'none' },
			guide: 'next',
			timeout: 100,
			...s,
		})),
		...extra,
	};
}

function loaded(config: Config): LoadedConfig {
	return { config, path: '/app/journey.config.ts', dir: '/app' };
}

test('JOURNEY_VARS is a JSON object of strings, and anything else is a clear error', () => {
	expect(envVars(undefined)).toEqual({});
	expect(envVars('')).toEqual({});
	expect(envVars('{"user":"ada","pin":4242,"on":true}')).toEqual({
		user: 'ada',
		pin: '4242',
		on: 'true',
	});
	expect(() => envVars('{user:ada}')).toThrow(/^journey: JOURNEY_VARS is not valid JSON: /);
	for (const raw of ['[1,2]', '"x"', 'null', '3']) {
		expect(() => envVars(raw)).toThrow('journey: JOURNEY_VARS must be a JSON object');
	}
});

test('env vars override config vars without touching the config', () => {
	const config: Config = { vars: { user: 'config', keep: 'yes' } };
	expect(withEnvVars(config, {})).toBe(config);
	expect(withEnvVars(config, { user: 'env' })).toEqual({ vars: { user: 'env', keep: 'yes' } });
	expect(config.vars).toEqual({ user: 'config', keep: 'yes' });
	expect(withEnvVars({}, { user: 'env' })).toEqual({ vars: { user: 'env' } });
});

test('variant names come from arrays or object keys, and custom viewports join the built-ins', () => {
	const config: Config = {
		variants: {
			viewport: { tablet: { width: 820, height: 1180 }, broken: { width: 'wide' }, mobile: {} },
			locale: ['en', 'fr'],
		},
	};
	expect(variantNames(config)).toEqual({
		viewport: ['tablet', 'broken', 'mobile'],
		locale: ['en', 'fr'],
	});
	expect(viewports(config)).toEqual({ ...BUILTIN_VIEWPORTS, tablet: { width: 820, height: 1180 } });
	expect(viewports({ variants: { viewport: ['desktop'] } })).toBe(BUILTIN_VIEWPORTS);
	expect(viewports({})).toBe(BUILTIN_VIEWPORTS);
});

test('the variant matrix takes the first value of each config dim unless the journey asks for more', () => {
	const config: Config = {
		variants: { viewport: ['desktop', 'mobile'], theme: ['light', 'dark'] },
	};
	expect(variantMatrix(config, ir())).toEqual([{ viewport: 'desktop', theme: 'light' }]);
	expect(variantMatrix(config, ir([], { variants: { theme: ['light', 'dark'] } }))).toEqual([
		{ viewport: 'desktop', theme: 'light' },
		{ viewport: 'desktop', theme: 'dark' },
	]);
	expect(
		variantMatrix(config, ir([], { variants: { viewport: ['mobile'], locale: ['en', 'ja'] } })),
	).toEqual([
		{ viewport: 'mobile', theme: 'light', locale: 'en' },
		{ viewport: 'mobile', theme: 'light', locale: 'ja' },
	]);
	expect(variantMatrix({}, ir())).toEqual([{ viewport: 'desktop' }]);
	expect(variantMatrix({ variants: { theme: [] } }, ir([], { variants: { locale: [] } }))).toEqual([
		{ viewport: 'desktop' },
	]);
});

test('variant keys and labels keep the dim order', () => {
	const variant = { viewport: 'mobile', theme: 'dark' };
	expect(variantKey(variant)).toBe('mobile-dark');
	expect(variantLabel(variant)).toBe('viewport=mobile theme=dark');
	expect(variantLabel({})).toBe('');
});

test('a --variant filter collects values per dim, and a dim it names must match', () => {
	const filter = parseVariantFilter('theme=dark,viewport=mobile,theme=light,theme=dark,', 'check');
	expect(filter).toEqual({ theme: ['dark', 'light'], viewport: ['mobile'] });
	expect(parseVariantFilter(undefined, 'check')).toEqual({});
	expect(() => parseVariantFilter('dark', 'test')).toThrow(
		'journey test: --variant expects dim=value, got "dark"',
	);
	expect(() => parseVariantFilter('=dark', 'check')).toThrow('got "=dark"');
	expect(matchesFilter({ theme: 'dark', viewport: 'mobile' }, filter)).toBe(true);
	expect(matchesFilter({ theme: 'dark', viewport: 'desktop' }, filter)).toBe(false);
	expect(matchesFilter({ theme: 'dark' }, filter)).toBe(false);
	expect(matchesFilter({ theme: 'dark' }, {})).toBe(true);
});

test('importDefault unwraps CommonJS interop layers down to the real default', () => {
	const config = { out: 'docs' };
	expect(importDefault({ default: config })).toBe(config);
	expect(importDefault({ default: { __esModule: true, default: config } })).toBe(config);
	expect(
		importDefault({
			default: { __esModule: true, default: { __esModule: true, default: config } },
		}),
	).toBe(config);
	expect(importDefault({})).toBeUndefined();
	expect(importDefault({ default: null })).toBeNull();
});

test('flagString ignores boolean flags and flagMillis accepts only non-negative numbers', () => {
	const argv = parseArgv(['book', '--presenter', 'spot', '--video', '--slow-mo=250']);
	expect(flagString(argv, 'presenter')).toBe('spot');
	expect(flagString(argv, 'video')).toBeUndefined();
	expect(flagString(argv, 'missing')).toBeUndefined();
	expect(flagMillis(argv, 'slow-mo')).toBe(250);
	expect(flagMillis(argv, 'missing')).toBeUndefined();
	for (const bad of ['--slow-mo=-1', '--slow-mo=fast', '--slow-mo=']) {
		expect(() => flagMillis(parseArgv(['book', bad]), 'slow-mo')).toThrow(
			/^journey: --slow-mo expects milliseconds, got /,
		);
	}
	expect(() => flagMillis({ ...argv, flags: { 'slow-mo': true } }, 'slow-mo')).toThrow(
		'journey: --slow-mo expects milliseconds, got "true"',
	);
	expect(flagMillis(parseArgv(['book', '--slow-mo= 0 ']), 'slow-mo')).toBe(0);
});

test('book takes presenter and placement from the flag, then the config, then the default', () => {
	const none = parseArgv(['book']);
	expect(presenterOf(none, loaded({}))).toBe('doc');
	expect(presenterOf(none, loaded({ presenter: 'guide' }))).toBe('guide');
	expect(
		presenterOf(parseArgv(['book', '--presenter', 'spot']), loaded({ presenter: 'guide' })),
	).toBe('spot');
	expect(() => presenterOf(parseArgv(['book', '--presenter', 'slides']), loaded({}))).toThrow(
		'journey book: unknown presenter "slides"',
	);
	expect(placementOf(none, loaded({}))).toBe('anchored');
	expect(placementOf(none, loaded({ placement: 'banner' }))).toBe('banner');
	expect(() => placementOf(parseArgv(['book', '--placement=top']), loaded({}))).toThrow(
		'journey book: unknown placement "top"',
	);
});

test('book records video when asked or when any step captures video', () => {
	expect(wantsVideo(ir([{}]), false)).toBe(false);
	expect(wantsVideo(ir([{}]), true)).toBe(true);
	expect(wantsVideo(ir([{}, { capture: { name: 'tour', video: true } }]), false)).toBe(true);
});

test('book selects journeys in the order asked and names a missing one', () => {
	const entry = (id: string) => ({ ir: ir([], { id }) }) as LoadedJourney;
	const all = [entry('a'), entry('b'), entry('c')];
	expect(selectJourneys(all, [])).toBe(all);
	expect(selectJourneys(all, ['c', 'a']).map((e) => e.ir.id)).toEqual(['c', 'a']);
	expect(() => selectJourneys(all, ['a', 'zz'])).toThrow(
		'journey book: "zz" is not among the configured journeys',
	);
});

test('check grades targets: paths are stable, locators a fallback, css fragile', () => {
	expect(targetHealth('save')).toBe('stable');
	expect(targetHealth({ role: 'button', name: 'Save' })).toBe('fallback');
	expect(targetHealth({ css: '.btn' })).toBe('fragile');
	expect(targetHealth({ testid: 'save', css: '.btn' })).toBe('fragile');
	expect(
		healthCounts(ir([{ target: 'a' }, { target: { text: 'Hi' } }, { target: { css: 'b' } }, {}])),
	).toEqual({ stable: 1, fallback: 1, fragile: 1 });
});

test('check passes a journey only when every run passes and, under strict, no target is unstable', () => {
	const base = { id: 'j', file: 'j.ts', targets: { stable: 1, fallback: 0, fragile: 0 } };
	const run = (ok: boolean) => ({ variant: {}, ok, failures: [] });
	const unstable = [{ step: 's', health: 'fragile' as const, target: '{"css":".x"}' }];
	expect(journeyOk({ ...base, unstable: [], runs: [run(true), run(true)] }, true)).toBe(true);
	expect(journeyOk({ ...base, unstable: [], runs: [run(true), run(false)] }, false)).toBe(false);
	expect(journeyOk({ ...base, unstable, runs: [run(true)] }, false)).toBe(true);
	expect(journeyOk({ ...base, unstable, runs: [run(true)] }, true)).toBe(false);
	const journey = { ...base, ok: true, unstable: [], runs: [] };
	expect(reportOk({ strict: false, errors: [], journeys: [journey] })).toBe(true);
	expect(reportOk({ strict: false, errors: ['bad file'], journeys: [journey] })).toBe(false);
	expect(reportOk({ strict: false, errors: [], journeys: [{ ...journey, ok: false }] })).toBe(
		false,
	);
});

test('escapeHtml escapes markup and attribute quotes', () => {
	expect(escapeHtml(`<a href="x">Tom & Jerry</a>`)).toBe(
		'&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;',
	);
});

test('prefixFiles rebases every file of a variant and keeps absent media absent', () => {
	const variant = {
		captures: [{ index: 0, name: 'a', file: '01-a.png', title: 'A' }],
		video: { webm: 'tour.webm', mp4: 'tour.mp4' },
		captions: 'tour.vtt',
		storyboard: 'storyboard.png',
	};
	expect(prefixFiles(variant, 'desktop')).toEqual({
		captures: [{ index: 0, name: 'a', file: 'desktop/01-a.png', title: 'A' }],
		video: { webm: 'desktop/tour.webm', mp4: 'desktop/tour.mp4' },
		captions: 'desktop/tour.vtt',
		storyboard: 'desktop/storyboard.png',
	});
	expect(variant.captures[0]?.file).toBe('01-a.png');
	expect(prefixFiles({ captures: [] }, 'm')).toEqual({ captures: [] });
});

test('page variants are the cross product of non-empty dims, desktop when there are none', () => {
	expect(combinations({ viewport: ['desktop', 'mobile'], theme: ['dark'], locale: [] })).toEqual([
		{ viewport: 'desktop', theme: 'dark' },
		{ viewport: 'mobile', theme: 'dark' },
	]);
	expect(combinations({})).toEqual([{ viewport: 'desktop' }]);
	expect(combinations({ theme: [] })).toEqual([{ viewport: 'desktop' }]);
});

test('the pages index has one table per page linking each variant screenshot', () => {
	expect(
		renderPagesIndex([
			{ name: 'home', route: '/', keys: ['desktop', 'mobile'] },
			{ name: 'settings', route: '/settings', keys: ['desktop'] },
		]),
	).toBe(
		[
			'# Pages',
			'',
			'## home',
			'',
			'Route: `/`',
			'',
			'| desktop | mobile |',
			'| --- | --- |',
			'| ![desktop](home/desktop.png) | ![mobile](home/mobile.png) |',
			'',
			'## settings',
			'',
			'Route: `/settings`',
			'',
			'| desktop |',
			'| --- |',
			'| ![desktop](settings/desktop.png) |',
			'',
		].join('\n'),
	);
	expect(renderPagesIndex([])).toBe('# Pages\n');
});

test('a crop pads the element and stays inside the viewport', () => {
	const viewport = { width: 1280, height: 800 };
	expect(clipRect({ x: 100, y: 100, width: 50, height: 20 }, viewport)).toEqual({
		x: 100 - CROP_PADDING,
		y: 100 - CROP_PADDING,
		width: 50 + 2 * CROP_PADDING,
		height: 20 + 2 * CROP_PADDING,
	});
	expect(clipRect({ x: 5, y: 5, width: 10, height: 10 }, viewport)).toEqual({
		x: 0,
		y: 0,
		width: 15 + CROP_PADDING,
		height: 15 + CROP_PADDING,
	});
	expect(clipRect({ x: 1270, y: 790, width: 50, height: 50 }, viewport)).toEqual({
		x: 1270 - CROP_PADDING,
		y: 790 - CROP_PADDING,
		width: 10 + CROP_PADDING,
		height: 10 + CROP_PADDING,
	});
	expect(clipRect({ x: 2000, y: 2000, width: 10, height: 10 }, viewport)).toMatchObject({
		width: 1,
		height: 1,
	});
});

test('screenshots retry only the transient capture error, a bounded number of times', async () => {
	const page = (failures: string[]) => {
		const waits: number[] = [];
		let calls = 0;
		return {
			waits,
			calls: () => calls,
			screenshot: async () => {
				const failure = failures[calls];
				calls += 1;
				if (failure !== undefined) throw new Error(failure);
				return Buffer.from('png');
			},
			waitForTimeout: async (ms: number) => {
				waits.push(ms);
			},
		};
	};
	const flaky = page(['Unable to capture screenshot', 'Unable to capture screenshot']);
	expect((await retryScreenshot(flaky, { type: 'png' })).toString()).toBe('png');
	expect(flaky.calls()).toBe(3);
	expect(flaky.waits).toEqual([100, 100]);
	const broken = page(Array(5).fill('Unable to capture screenshot'));
	await expect(retryScreenshot(broken, { type: 'png' })).rejects.toThrow('Unable to capture');
	expect(broken.calls()).toBe(3);
	const closed = page(['Target page, context or browser has been closed']);
	await expect(retryScreenshot(closed, { type: 'png' })).rejects.toThrow('has been closed');
	expect(closed.calls()).toBe(1);
});

test('the start url flags same-origin routes for a run and leaves other origins alone', () => {
	expect(startUrl('http://localhost:3000', '/notes?x=1#top')).toBe(
		'http://localhost:3000/notes?x=1&journey=run#top',
	);
	expect(startUrl('http://localhost:3000/app/', 'settings')).toBe(
		'http://localhost:3000/app/settings?journey=run',
	);
	expect(startUrl('http://localhost:3000', 'https://auth.example.com/login')).toBe(
		'https://auth.example.com/login',
	);
});

test('errorLine keeps the first line of a multi-line error', () => {
	expect(errorLine(new Error('locator.click: Timeout 30000ms\nCall log:\n  - waiting'))).toBe(
		'locator.click: Timeout 30000ms',
	);
	expect(errorLine('  plain  ')).toBe('plain');
	expect(errorLine(42)).toBe('42');
});

test('failureMessage lists one step per line', () => {
	expect(
		failureMessage({
			ok: false,
			completed: 1,
			failures: [
				{ stepId: 'save', error: 'target save: 0 matches after 100ms' },
				{ stepId: 'done', error: 'url /done: /' },
			],
		}),
	).toBe('step save: target save: 0 matches after 100ms\nstep done: url /done: /');
	expect(failureMessage({ ok: true, completed: 1, failures: [] })).toBe('');
});

test('storage state comes from the fixture, then the config, relative to the config dir', () => {
	const config: Config = {
		storageState: 'auth/user.json',
		fixtures: { admin: { storageState: '/abs/admin.json' }, plain: {} },
	};
	expect(storageStatePath(undefined, config, '/app')).toBe(join('/app', 'auth/user.json'));
	expect(storageStatePath('admin', config, '/app')).toBe('/abs/admin.json');
	expect(storageStatePath('plain', config, '/app')).toBe(join('/app', 'auth/user.json'));
	expect(storageStatePath(undefined, {}, '/app')).toBeUndefined();
	expect(resolveFrom('/app', '../x')).toBe('/x');
});
