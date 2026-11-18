import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { expect, test } from '@playwright/test';
import { BASE } from './helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/cli/main.js');

function journeyTest(args: string[]): { code: number; output: string } {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(PW_|PLAYWRIGHT_|TEST_|CI$)/.test(key)) env[key] = value;
	}
	const run = spawnSync(process.execPath, [cli, 'test', ...args], {
		cwd: root,
		env,
		encoding: 'utf8',
		timeout: 120000,
	});
	return {
		code: run.status ?? 1,
		output: stripVTControlCharacters(`${run.stdout}\n${run.stderr}`),
	};
}

test('the config test key sets journey test defaults and CLI flags still win', async () => {
	test.setTimeout(240000);
	const dir = mkdtempSync(join(tmpdir(), 'journey-test-config-'));
	try {
		writeFileSync(
			join(dir, 'journey.config.ts'),
			`export default {
	app: { url: '${BASE}' },
	journeys: '*.journey.ts',
	out: 'out',
	test: { retries: 2, workers: 1, use: { trace: 'on' } },
};\n`,
		);
		for (const id of ['passes', 'fails']) {
			const expectation = id === 'fails' ? `{ visible: 'missing' }` : `{ visible: 'nav' }`;
			writeFileSync(
				join(dir, `${id}.journey.ts`),
				`export default { id: '${id}', title: '${id}', route: '/', steps: [{ id: 'look', timeout: 300, expect: [${expectation}] }] };\n`,
			);
		}
		const configPath = join(dir, 'journey.config.ts');
		const results = join(dir, 'out', '.test-results');

		const defaults = journeyTest(['--config', configPath]);
		expect(defaults.code, defaults.output).toBe(1);
		expect(defaults.output).toContain('Running 2 tests using 1 worker');
		const dirs = readdirSync(results);
		expect(dirs.filter((name) => name.includes('fails')).sort(), defaults.output).toHaveLength(3);
		expect(
			dirs.some((name) => name.endsWith('-retry2')),
			dirs.join('\n'),
		).toBe(true);
		const [passed] = dirs.filter((name) => name.includes('passes'));
		expect(readdirSync(join(results, passed as string))).toContain('trace.zip');

		const flags = journeyTest(['--config', configPath, '--retries=0', '--trace=off']);
		expect(flags.code, flags.output).toBe(1);
		const after = readdirSync(results);
		expect(
			after.filter((name) => name.includes('fails')),
			flags.output,
		).toHaveLength(1);
		for (const entry of readdirSync(results, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				expect(readdirSync(join(results, entry.name))).not.toContain('trace.zip');
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
