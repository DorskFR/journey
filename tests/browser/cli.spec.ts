import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import demoConfig from '../../demo/journey.config.js';
import { variantKey, variantMatrix } from '../../src/cli/config.js';
import { hasFfmpeg } from '../../src/cli/media.js';
import { forwardExportScript, mountEditorIn, saveExport } from '../../src/cli/record.js';
import type { Manifest } from '../../src/cli/report.js';
import type { IR } from '../../src/index.js';
import { BASE, createNoteIR, RUNTIME_INIT, settingsThemeIR } from './helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/cli/main.js');
const config = join(root, 'demo/journey.config.ts');

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { CI: '1' };
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(PW_|PLAYWRIGHT_|TEST_)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

function journey(args: string[]): Promise<Run> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: cleanEnv() });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
	});
}

test('compile prints the IR of every journey and --public strips qaOnly steps', async () => {
	const full = await journey(['compile', '--config', config]);
	expect(full.code, full.stderr).toBe(0);
	const irs = JSON.parse(full.stdout) as IR[];
	expect(irs.map((ir) => ir.id)).toEqual(['create-note', 'settings-theme']);
	expect(irs[1]?.steps.map((s) => s.id)).toContain('escape');

	const pub = await journey(['compile', '--public', '--config', config]);
	expect(pub.code, pub.stderr).toBe(0);
	const publicIrs = JSON.parse(pub.stdout) as IR[];
	expect(publicIrs[1]?.steps.map((s) => s.id)).toEqual(['theme', 'dark-only', 'back']);

	const out = join(mkdtempSync(join(tmpdir(), 'journey-')), 'ir.json');
	const written = await journey(['compile', '-o', out, '--config', config]);
	expect(written.code).toBe(0);
	expect((JSON.parse(readFileSync(out, 'utf8')) as IR[]).length).toBe(2);
});

test('unknown commands exit 1 with usage', async () => {
	const bogus = await journey(['bogus']);
	expect(bogus.code).toBe(1);
	expect(bogus.stderr).toContain('Usage: journey');
	const help = await journey(['--help']);
	expect(help.code).toBe(0);
	expect(help.stdout).toContain('compile');
});

test('check runs every journey and variant against the running demo', async () => {
	const run = await journey(['check', '--config', config]);
	expect(run.code, run.stderr).toBe(0);
	const lines = run.stdout.trim().split('\n');
	expect(lines).toHaveLength(3);
	for (const line of lines)
		expect(line).toMatch(/^✓ .+ \[viewport=\w+ theme=light\] fallback 0 fragile 0$/);
	expect(lines[0]).toContain('create-note [viewport=desktop theme=light]');
	expect(lines[2]).toContain('settings-theme');
});

test('test spawns playwright with the generated config and exits 0', async () => {
	test.setTimeout(180000);
	const run = await journey(['test', '--config', config]);
	expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
	expect(run.stdout).toContain('3 passed');
});

test('record plumbing forwards journey:export and writes source, storage and HAR', async ({
	browser,
}) => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-record-'));
	const har = join(dir, 'fixtures', 'recording.har');
	const context = await browser.newContext({ recordHar: { path: har, mode: 'minimal' } });
	await context.addInitScript(RUNTIME_INIT);
	await context.addInitScript(forwardExportScript());
	const page = await context.newPage();
	const exported = new Promise<string[]>((done) => {
		void page.exposeFunction('__journeyExport', (payload: { id: string; source: string }) =>
			saveExport(context, payload, { url: BASE, dir, har: true, headless: true }).then(done),
		);
	});
	await page.goto(`${BASE}/`);
	await mountEditorIn(page);
	expect(await page.evaluate(() => window.__journey?.options.editor)).toBe(true);
	await page.evaluate(() => {
		localStorage.setItem('demo-marker', '1');
		window.dispatchEvent(
			new CustomEvent('journey:export', {
				detail: { id: 'recorded', source: 'export default {};\n' },
			}),
		);
	});
	const files = await exported;
	await context.close();
	expect(files).toEqual([
		join(dir, 'recorded.journey.ts'),
		join(dir, 'fixtures', 'recorded.storage.json'),
		join(dir, 'fixtures', 'recorded.har'),
	]);
	expect(readFileSync(files[0] as string, 'utf8')).toBe('export default {};\n');
	expect(readFileSync(files[1] as string, 'utf8')).toContain('demo-marker');
	expect(existsSync(har)).toBe(true);
});

const out = join(root, 'demo/out');

test.describe('book and pages', () => {
	test.beforeAll(() => {
		rmSync(out, { recursive: true, force: true });
	});

	test('book captures create-note on desktop with video, storyboard and reports', async () => {
		test.setTimeout(120000);
		const run = await journey([
			'book',
			'create-note',
			'--variant',
			'viewport=desktop',
			'--config',
			config,
			'--video',
		]);
		expect(run.code, run.stderr).toBe(0);
		const keys = variantMatrix(demoConfig, createNoteIR)
			.filter((v) => v.viewport === 'desktop')
			.map(variantKey);
		expect(keys).toHaveLength(1);
		const key = keys[0] as string;
		expect(run.stdout.trim().split('\n')).toHaveLength(1);
		expect(run.stdout).toContain(`✓ create-note`);
		const dir = join(out, 'create-note', key);
		for (const file of ['01-notes.png', '02-dialog.png', '03-saved.png', 'storyboard.png']) {
			expect(existsSync(join(dir, file)), file).toBe(true);
		}
		const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
		expect(manifest.id).toBe('create-note');
		expect(manifest.title).toBe('Create a note');
		expect(Object.keys(manifest.variants)).toEqual([key]);
		const variant = manifest.variants[key];
		expect(variant?.captures.map((c) => c.title)).toEqual(['Welcome', 'New note', 'Save']);
		expect(variant?.captures.map((c) => c.file)).toEqual([
			'01-notes.png',
			'02-dialog.png',
			'03-saved.png',
		]);
		expect(variant?.storyboard).toBe('storyboard.png');
		const md = readFileSync(join(dir, 'index.md'), 'utf8');
		expect(md).toContain('![notes](01-notes.png)');
		expect(md).toContain('**Welcome**');
		const html = readFileSync(join(dir, 'index.html'), 'utf8');
		expect(html).toContain('<figure>');
		expect(html).toContain('<strong>Welcome</strong>');
		const webm = join(dir, 'tour.webm');
		const mp4 = join(dir, 'tour.mp4');
		expect(existsSync(webm) || existsSync(mp4)).toBe(true);
		if (hasFfmpeg()) {
			expect(existsSync(mp4)).toBe(true);
			expect(statSync(mp4).size).toBeGreaterThan(0);
			expect(variant?.video?.mp4).toBe('tour.mp4');
			expect(variant?.video?.webm).toBe('tour.webm');
		}
		const combined = JSON.parse(
			readFileSync(join(out, 'create-note', 'manifest.json'), 'utf8'),
		) as Manifest;
		expect(combined.variants[key]?.captures[0]?.file).toBe(`${key}/01-notes.png`);
	});

	test('book with the guide presenter runs settings-theme on its matrix', async () => {
		test.setTimeout(120000);
		const run = await journey([
			'book',
			'--presenter',
			'guide',
			'settings-theme',
			'--config',
			config,
		]);
		expect(run.code, run.stderr).toBe(0);
		const keys = variantMatrix(demoConfig, settingsThemeIR).map(variantKey);
		expect(keys).toEqual(['desktop-light']);
		expect(run.stdout.trim().split('\n')).toHaveLength(keys.length);
		for (const key of keys) {
			const dir = join(out, 'settings-theme', key);
			expect(existsSync(join(dir, '01-dark.png')), key).toBe(true);
			expect(existsSync(join(dir, '02-dark.png'))).toBe(false);
			const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
			expect(manifest.variants[key]?.captures).toHaveLength(1);
		}
	});

	test('pages screenshots every configured route per variant and writes an index', async () => {
		test.setTimeout(120000);
		const run = await journey(['pages', '--config', config]);
		expect(run.code, run.stderr).toBe(0);
		const key = variantKey(variantMatrix(demoConfig, settingsThemeIR)[0] as Record<string, string>);
		for (const name of ['home', 'notes', 'settings']) {
			expect(existsSync(join(out, 'pages', name, `${key}.png`)), name).toBe(true);
		}
		const md = readFileSync(join(out, 'pages', 'index.md'), 'utf8');
		for (const name of ['home', 'notes', 'settings']) {
			expect(md).toContain(`## ${name}`);
			expect(md).toContain(`| ![${key}](${name}/${key}.png)`);
		}
		expect(md.match(/^\| !\[/gm)).toHaveLength(3);
	});

	test('help lists book and pages with their flags', async () => {
		const help = await journey(['--help']);
		expect(help.code).toBe(0);
		expect(help.stdout).toMatch(/book \[id\.\.\.\].*--presenter.*--video.*--variant/);
		expect(help.stdout).toContain('pages');
		const book = await journey(['book', '--help']);
		expect(book.code).toBe(0);
		expect(book.stdout).toContain('--variant dim=value');
		const pages = await journey(['pages', '--help']);
		expect(pages.code).toBe(0);
		expect(pages.stdout).toContain('Usage: journey pages');
	});
});
