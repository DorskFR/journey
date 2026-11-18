// Packs the built package, installs the tarball into a throwaway project and
// checks every entry point the way a consumer would load it. Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const NAME = pkg.name;
const failures = [];

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function check(label, fn) {
	try {
		const detail = fn();
		console.log(`ok   ${label}${detail ? `: ${detail}` : ''}`);
	} catch (error) {
		const out = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
		failures.push(label);
		console.log(`FAIL ${label}\n${(out || error.message).replace(/^/gm, '     ')}`);
	}
}

function node(cwd, source, type = 'module') {
	const flag = type === 'module' ? '--input-type=module' : '--input-type=commonjs';
	return run(process.execPath, [flag, '-e', source], { cwd }).trim();
}

function link(project, name) {
	const target = join(project, 'node_modules', name);
	mkdirSync(dirname(target), { recursive: true });
	symlinkSync(join(repo, 'node_modules', name), target, 'dir');
}

if (!existsSync(join(repo, 'dist', 'index.js'))) {
	console.error('pack-smoke: dist/ is missing, run `npm run build` first');
	process.exit(1);
}

const packDir = mkdtempSync(join(tmpdir(), 'journey-pack-'));
const project = mkdtempSync(join(tmpdir(), 'journey-smoke-'));
try {
	const [packed] = JSON.parse(
		run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
			cwd: repo,
		}),
	);
	const files = packed.files.map((f) => f.path);
	const tarball = join(packDir, packed.filename);
	console.log(
		`packed ${packed.filename}: ${files.length} files, ${packed.unpackedSize} bytes unpacked`,
	);

	check('no source maps pointing at unshipped sources', () => {
		const maps = files.filter((f) => f.endsWith('.map'));
		if (maps.length) throw new Error(`ships ${maps.length} maps, e.g. ${maps[0]}`);
	});
	check('internal playwright files ship without declarations', () => {
		const internal = files.filter((f) => /journeys\.(config|spec)\.d\.ts$/.test(f));
		if (internal.length) throw new Error(internal.join(', '));
	});

	writeFileSync(
		join(project, 'package.json'),
		JSON.stringify({ name: 'journey-smoke', private: true, type: 'module' }),
	);
	check(`npm install --engine-strict on node ${process.versions.node}`, () => {
		run(
			'npm',
			[
				'install',
				'--offline',
				'--engine-strict',
				'--no-audit',
				'--no-fund',
				'--no-package-lock',
				tarball,
			],
			{ cwd: project },
		);
	});
	if (failures.length) throw new Error('pack-smoke: install failed, skipping the entry checks');

	const ESM = {
		'': ['defineJourney', 'compile', 'param', 'msg'],
		'/runtime': ['mount'],
		'/editor': ['mountEditor'],
	};
	for (const [sub, names] of Object.entries(ESM)) {
		const id = `${NAME}${sub}`;
		const want = JSON.stringify(names);
		check(`import('${id}')`, () =>
			node(
				project,
				`const m = await import('${id}'); const miss = ${want}.filter((n) => typeof m[n] !== 'function'); if (miss.length) throw new Error('missing ' + miss); console.log(Object.keys(m).length + ' exports');`,
			),
		);
		check(`require('${id}')`, () =>
			node(
				project,
				`const m = require('${id}'); const miss = ${want}.filter((n) => typeof m[n] !== 'function'); if (miss.length) throw new Error('missing ' + miss); console.log(Object.keys(m).length + ' exports');`,
				'commonjs',
			),
		);
	}
	check(`${NAME}/playwright without @playwright/test explains the peer`, () => {
		for (const [source, type] of [
			[`await import('${NAME}/playwright')`, 'module'],
			[`require('${NAME}/playwright')`, 'commonjs'],
		]) {
			let message = '';
			try {
				node(project, source, type);
			} catch (error) {
				message = String(error.stderr);
			}
			if (!message.includes('npm i -D @playwright/test')) {
				throw new Error(`${type}: ${message || 'loaded without @playwright/test'}`);
			}
		}
	});
	check('iife bundles and package.json resolve', () => {
		const source = `for (const id of ['${NAME}/runtime.iife.js', '${NAME}/editor.iife.js', '${NAME}/package.json']) require('node:fs').statSync(require.resolve(id)); console.log(require('${NAME}/package.json').version);`;
		const version = node(project, source, 'commonjs');
		if (version !== pkg.version) throw new Error(`version ${version}, expected ${pkg.version}`);
		return version;
	});
	check('journey --version', () => {
		const out = run(join(project, 'node_modules', '.bin', 'journey'), ['--version'], {
			cwd: project,
		}).trim();
		if (!out.includes(pkg.version)) throw new Error(`printed "${out}"`);
		return out;
	});

	link(project, '@playwright/test');
	link(project, '@types/node');
	check(`import('${NAME}/playwright')`, () =>
		node(
			project,
			`const m = await import('${NAME}/playwright'); for (const n of ['test', 'expect', 'runJourney', 'journeyTests']) if (!m[n]) throw new Error('missing ' + n); console.log(Object.keys(m).length + ' exports');`,
		),
	);
	check(`require('${NAME}/playwright')`, () =>
		node(
			project,
			`const m = require('${NAME}/playwright'); for (const n of ['test', 'expect', 'runJourney', 'journeyTests']) if (!m[n]) throw new Error('missing ' + n); console.log(Object.keys(m).length + ' exports');`,
			'commonjs',
		),
	);

	writeFileSync(
		join(project, 'esm.mts'),
		`import { defineJourney, type IR } from '${NAME}';
import { mount } from '${NAME}/runtime';
import { mountEditor } from '${NAME}/editor';
import { runJourney, test } from '${NAME}/playwright';
const j = defineJourney({ id: 'j', route: '/', steps: [] });
export const used: unknown[] = [j, mount, mountEditor, runJourney, test];
export type { IR };
`,
	);
	writeFileSync(
		join(project, 'cjs.cts'),
		`import journey = require('${NAME}');
import pw = require('${NAME}/playwright');
const j: ReturnType<typeof journey.defineJourney> = journey.defineJourney({ id: 'j', route: '/', steps: [] });
export const used: unknown[] = [j, pw.runJourney, pw.test];
`,
	);
	writeFileSync(
		join(project, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				module: 'node16',
				moduleResolution: 'node16',
				target: 'es2022',
				lib: ['es2022', 'dom'],
				types: ['node'],
				strict: true,
				noEmit: true,
				skipLibCheck: false,
			},
			files: ['esm.mts', 'cjs.cts'],
		}),
	);
	const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
	check('types resolve for ESM and CommonJS consumers (module node16)', () => {
		run(process.execPath, [tsc, '-p', '.'], { cwd: project });
	});
	writeFileSync(
		join(project, 'require-esm.cts'),
		`import runtime = require('${NAME}/runtime');
import editor = require('${NAME}/editor');
export const used: unknown[] = [runtime.mount, editor.mountEditor];
`,
	);
	check('runtime and editor types resolve through require(esm) (module nodenext)', () => {
		writeFileSync(
			join(project, 'tsconfig.nodenext.json'),
			JSON.stringify({
				extends: './tsconfig.json',
				compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
				files: ['require-esm.cts'],
			}),
		);
		run(process.execPath, [tsc, '-p', 'tsconfig.nodenext.json'], { cwd: project });
	});
} finally {
	rmSync(project, { recursive: true, force: true });
	rmSync(packDir, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`\npack-smoke: ${failures.length} failed: ${failures.join('; ')}`);
	process.exit(1);
}
console.log('\npack-smoke: all checks passed');
