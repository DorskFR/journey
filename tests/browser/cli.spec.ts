import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { forwardExportScript, mountEditorIn, saveExport } from '../../src/cli/record.js';
import type { IR } from '../../src/index.js';
import { BASE, RUNTIME_INIT } from './helpers.js';

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

test('unknown commands and stubs exit 1 with usage', async () => {
	const bogus = await journey(['bogus']);
	expect(bogus.code).toBe(1);
	expect(bogus.stderr).toContain('Usage: journey');
	const book = await journey(['book', '--config', config]);
	expect(book.code).toBe(1);
	expect(book.stderr).toContain('not implemented yet');
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
