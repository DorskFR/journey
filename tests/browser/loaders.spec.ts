import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL_HINT = 'npm i -D @playwright/test';

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

function node(cwd: string, args: string[]): Run {
	const run = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000 });
	return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function journey(cwd: string, args: string[]): Run {
	return node(cwd, [join(cwd, 'node_modules/@dorsk/journey/dist/cli/main.js'), ...args]);
}

function write(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
}

function project(withPlaywright: boolean, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'journey-loaders-'));
	const pkg = join(dir, 'node_modules/@dorsk/journey');
	mkdirSync(pkg, { recursive: true });
	if (withPlaywright) {
		rmSync(pkg, { recursive: true });
		symlinkSync(root, pkg, 'dir');
		mkdirSync(join(dir, 'node_modules/@playwright'));
		symlinkSync(
			join(root, 'node_modules/@playwright/test'),
			join(dir, 'node_modules/@playwright/test'),
			'dir',
		);
	} else {
		cpSync(join(root, 'package.json'), join(pkg, 'package.json'));
		cpSync(join(root, 'dist'), join(pkg, 'dist'), { recursive: true });
	}
	write(dir, {
		'journey.config.ts': `import { defineConfig } from '@dorsk/journey';
export default defineConfig({ app: { url: 'http://localhost:1/' }, journeys: 'journeys/*.journey.ts' });
`,
		...files,
	});
	return dir;
}

const TS_FEATURES = {
	'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }),
	'src/routes.ts': `export const HOME = '/home';\n`,
	'src/ids.ts': `export const BUTTON = 'save';\n`,
	'journeys/a.journey.ts': `import { defineJourney } from '@dorsk/journey';
import { HOME } from '../src/routes';
import { BUTTON } from '@app/ids';
enum Kind { Click = 'click' }
export default defineJourney({ id: 'a', route: HOME, steps: [{ id: BUTTON, target: 'x', do: { kind: Kind.Click } }] });
`,
};

for (const type of ['commonjs', 'module'] as const) {
	test(`compile loads TypeScript like journey test does in a ${type} package`, () => {
		const dir = project(true, {
			...TS_FEATURES,
			'package.json': JSON.stringify({
				name: 'c',
				private: true,
				...(type === 'module' ? { type } : {}),
			}),
		});
		try {
			const run = journey(dir, ['compile']);
			expect(run.stderr).toBe('');
			expect(run.code).toBe(0);
			const [ir] = JSON.parse(run.stdout) as Array<{
				id: string;
				route: string;
				steps: Array<{ id: string; do: { kind: string } }>;
			}>;
			expect(ir?.route).toBe('/home');
			expect(ir?.steps[0]).toMatchObject({ id: 'save', do: { kind: 'click' } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test.describe('without @playwright/test installed', () => {
	let dir = '';

	test.beforeAll(() => {
		dir = project(false, {
			'package.json': JSON.stringify({ name: 'c', private: true, type: 'module' }),
			'journeys/plain.journey.ts': `import { defineJourney } from '@dorsk/journey';
export default defineJourney({ id: 'plain', steps: [{ id: 's', say: { body: 'hi' } }] });
`,
		});
	});

	test.afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('the peer is optional', () => {
		const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		expect(pkg.peerDependenciesMeta?.['@playwright/test']?.optional).toBe(true);
		expect(node(dir, ['-e', "require.resolve('@playwright/test')"]).code).not.toBe(0);
	});

	for (const entry of ['@dorsk/journey', '@dorsk/journey/runtime', '@dorsk/journey/editor']) {
		test(`${entry} imports and requires in Node`, () => {
			const esm = node(dir, [
				'--input-type=module',
				'-e',
				`await import(${JSON.stringify(entry)})`,
			]);
			expect(esm.stderr).toBe('');
			expect(esm.code).toBe(0);
			const cjs = node(dir, ['-e', `require(${JSON.stringify(entry)})`]);
			expect(cjs.stderr).toBe('');
			expect(cjs.code).toBe(0);
		});
	}

	test('mountEditor outside a browser says it needs one', () => {
		const run = node(dir, [
			'--input-type=module',
			'-e',
			"const { mountEditor } = await import('@dorsk/journey/editor'); try { mountEditor(); } catch (e) { console.log(e.message); }",
		]);
		expect(run.stdout.trim()).toBe('journey: mountEditor needs a browser; call it client-side');
	});

	test('@dorsk/journey/playwright tells how to install the peer', () => {
		const esm = node(dir, [
			'--input-type=module',
			'-e',
			"await import('@dorsk/journey/playwright')",
		]);
		expect(esm.code).not.toBe(0);
		expect(esm.stderr).toContain(INSTALL_HINT);
		const cjs = node(dir, ['-e', "require('@dorsk/journey/playwright')"]);
		expect(cjs.code).not.toBe(0);
		expect(cjs.stderr).toContain(INSTALL_HINT);
	});

	test('compile still works, and strip-only failures explain the TypeScript subset', () => {
		const ok = journey(dir, ['compile']);
		expect(ok.code).toBe(0);
		expect(JSON.parse(ok.stdout)).toMatchObject([{ id: 'plain' }]);
		write(dir, {
			'journeys/enum.journey.ts': `enum Kind { A = 'a' }\nexport default { id: Kind.A, steps: [] };\n`,
		});
		try {
			const run = journey(dir, ['compile']);
			expect(run.code).toBe(1);
			expect(run.stderr).toContain('enum.journey.ts: import failed');
			expect(run.stderr).toContain('Install @playwright/test to load it like `journey test` does.');
		} finally {
			rmSync(join(dir, 'journeys/enum.journey.ts'));
		}
	});

	test('browser commands ask for the peer', () => {
		const run = journey(dir, ['check']);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(INSTALL_HINT);
	});
});
