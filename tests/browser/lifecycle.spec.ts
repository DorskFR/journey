import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import { runJourney } from '../../src/playwright/index.js';
import { BASE, createNoteIR } from './helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/cli/main.js');

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();
		server.once('error', fail);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function answers(url: string): Promise<boolean> {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
	} catch {
		return false;
	}
}

function project(start: string, port: number): string {
	const dir = mkdtempSync(join(tmpdir(), 'journey-lifecycle-'));
	writeFileSync(
		join(dir, 'journey.config.mjs'),
		`export default ${JSON.stringify({
			app: { url: `http://127.0.0.1:${port}/`, start, timeout: 15000 },
			journeys: 'journeys/*.journey.mjs',
			out: 'out',
		})};\n`,
	);
	return dir;
}

function launch(
	args: string[],
	env: NodeJS.ProcessEnv,
): { child: ChildProcess; done: Promise<Run> } {
	const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (d: Buffer) => {
		stdout += d.toString();
	});
	child.stderr?.on('data', (d: Buffer) => {
		stderr += d.toString();
	});
	const done = new Promise<Run>((resolve) => {
		const killer = setTimeout(() => child.kill('SIGKILL'), 45000);
		child.on('close', (code, signal) => {
			clearTimeout(killer);
			resolve({ code, signal, stdout, stderr });
		});
	});
	return { child, done };
}

function serverScript(dir: string, port: number): string {
	const file = join(dir, 'server.mjs');
	writeFileSync(
		file,
		`import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync(${JSON.stringify(join(dir, 'server.pid'))}, String(process.pid));
createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');
`,
	);
	return `node ${JSON.stringify(file)}`;
}

function killLeftover(dir: string): void {
	const pidFile = join(dir, 'server.pid');
	if (!existsSync(pidFile)) return;
	const pid = Number(readFileSync(pidFile, 'utf8'));
	if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
}

for (const command of ['check', 'book', 'pages']) {
	test(`${command} exits and stops the app when the browser cannot launch`, async () => {
		test.setTimeout(60000);
		const port = await freePort();
		const dir = mkdtempSync(join(tmpdir(), 'journey-lifecycle-'));
		const proj = project(serverScript(dir, port), port);
		const configPath = join(proj, 'journey.config.mjs');
		if (command === 'pages') {
			writeFileSync(
				configPath,
				readFileSync(configPath, 'utf8').replace('"out":"out"', '"out":"out","pages":["/"]'),
			);
		}
		const browsers = mkdtempSync(join(tmpdir(), 'journey-no-browsers-'));
		try {
			const run = await launch([command, '--config', configPath], {
				...process.env,
				PLAYWRIGHT_BROWSERS_PATH: browsers,
			}).done;
			expect(run.signal, 'the CLI hung and was killed').toBeNull();
			expect(run.code).toBe(1);
			expect(run.stderr).toMatch(/Executable doesn't exist|playwright install/);
			const pid = Number(readFileSync(join(dir, 'server.pid'), 'utf8'));
			expect(alive(pid)).toBe(false);
			expect(await answers(`http://127.0.0.1:${port}/`)).toBe(false);
		} finally {
			killLeftover(dir);
			for (const d of [dir, proj, browsers]) rmSync(d, { recursive: true, force: true });
		}
	});
}

for (const [signal, code] of [
	['SIGTERM', 143],
	['SIGINT', 130],
] as const) {
	test(`${signal} while the app is starting stops it and exits ${code}`, async () => {
		test.setTimeout(60000);
		const port = await freePort();
		const dir = mkdtempSync(join(tmpdir(), 'journey-lifecycle-'));
		const pidFile = join(dir, 'server.pid');
		const start = `node -e "require('node:fs').writeFileSync(${JSON.stringify(pidFile).replace(/"/g, "'")}, String(process.pid)); setInterval(() => {}, 1000)"`;
		const proj = project(start, port);
		try {
			const { child, done } = launch(['check', '--config', join(proj, 'journey.config.mjs')], {
				...process.env,
			});
			await expect.poll(() => existsSync(pidFile), { timeout: 15000 }).toBe(true);
			const pid = Number(readFileSync(pidFile, 'utf8'));
			expect(alive(pid)).toBe(true);
			child.kill(signal);
			const run = await done;
			expect(run.code).toBe(code);
			await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
		} finally {
			killLeftover(dir);
			for (const d of [dir, proj]) rmSync(d, { recursive: true, force: true });
		}
	});
}

test('a failed action is the step failure, with its id and one line', async ({ page }) => {
	await page.addInitScript(() => {
		addEventListener('DOMContentLoaded', () => {
			const cover = document.createElement('div');
			cover.id = 'cookie-banner';
			cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
			document.body.append(cover);
		});
	});
	const covered: IR = {
		...createNoteIR,
		steps: createNoteIR.steps.map((s) => ({ ...s, timeout: 800 })),
	};
	const result = await runJourney(page, covered, { baseUrl: BASE, params: { 'var.title': 'x' } });
	expect(result.ok).toBe(false);
	expect(result.failures).toHaveLength(1);
	const failure = result.failures[0];
	const first = covered.steps.find((s) => s.do.kind === 'click');
	expect(failure?.stepId).toBe(first?.id);
	expect(failure?.error).toMatch(/^click failed: locator\.click: Timeout 800ms exceeded/);
	expect(failure?.error).not.toContain('\n');
	expect(result.completed).toBe(covered.steps.indexOf(first as (typeof covered.steps)[number]));
});
