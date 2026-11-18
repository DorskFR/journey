import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { withAppBrowser } from '../../src/cli/app.js';
import { bookRoot, captureFile, variantDir } from '../../src/cli/book.js';
import { type LoadedConfig, outDir } from '../../src/cli/config.js';
import {
	answers,
	applyFixture,
	type FixtureContext,
	OutputTail,
	startCommand,
} from '../../src/playwright/fixtures.js';

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

function serverCommand(port: number): string {
	return `node -e "require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"`;
}

function loadedWith(app: NonNullable<LoadedConfig['config']['app']>): LoadedConfig {
	return { config: { app }, path: join(process.cwd(), 'journey.config.ts'), dir: process.cwd() };
}

test('a browser that fails to launch still stops the app it started', async () => {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}/`;
	const loaded = loadedWith({ url, start: serverCommand(port), timeout: 10000 });
	let ran = false;
	await expect(
		withAppBrowser(
			loaded,
			{ headless: true },
			async () => {
				ran = true;
			},
			async () => {
				expect(await answers(url)).toBe(true);
				throw new Error("browserType.launch: Executable doesn't exist");
			},
		),
	).rejects.toThrow(/Executable doesn't exist/);
	expect(ran).toBe(false);
	expect(await answers(url)).toBe(false);
});

test('a failing run closes the browser and stops the app', async () => {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}/`;
	const loaded = loadedWith({ url, start: serverCommand(port), timeout: 10000 });
	let closed = false;
	const browser = {
		close: async () => {
			closed = true;
		},
	} as unknown as import('@playwright/test').Browser;
	await expect(
		withAppBrowser(
			loaded,
			{},
			async () => {
				throw new Error('boom');
			},
			async () => browser,
		),
	).rejects.toThrow('boom');
	expect(closed).toBe(true);
	expect(await answers(url)).toBe(false);
});

test('a command that dies before it is ready reports its exit code and output', async () => {
	const port = await freePort();
	const error = await startCommand('echo compiling; echo "EADDRINUSE: port taken" >&2; exit 3', {
		cwd: process.cwd(),
		ready: `http://127.0.0.1:${port}/`,
		timeout: 5000,
	}).then(
		() => undefined,
		(e: unknown) => e as Error,
	);
	expect(error?.message).toMatch(/exited with code 3/);
	expect(error?.message).toContain('compiling');
	expect(error?.message).toContain('EADDRINUSE: port taken');
});

test('a command that never answers reports the tail of its output', async () => {
	const port = await freePort();
	const started = Date.now();
	const error = await startCommand(
		'for i in $(seq 1 100); do echo "line $i"; done; exec sleep 30',
		{ cwd: process.cwd(), ready: `http://127.0.0.1:${port}/`, timeout: 1500 },
	).then(
		() => undefined,
		(e: unknown) => e as Error,
	);
	expect(Date.now() - started).toBeLessThan(10000);
	expect(error?.message).toMatch(/did not answer below 500 within 1500 ms/);
	expect(error?.message).toContain('line 100');
	expect(error?.message).toContain('line 61');
	expect(error?.message).not.toContain('line 60\n');
});

test('a command that ignores SIGTERM is killed at stop', async () => {
	test.setTimeout(20000);
	const ready = createHttpServer((_q, res) => res.end('ok'));
	await new Promise<void>((done) => ready.listen(0, '127.0.0.1', done));
	const address = ready.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	try {
		const stop = await startCommand(`trap '' TERM; while :; do sleep 0.2; done`, {
			cwd: process.cwd(),
			ready: `http://127.0.0.1:${port}/`,
			timeout: 5000,
		});
		const started = Date.now();
		await stop();
		expect(Date.now() - started).toBeGreaterThan(4000);
	} finally {
		await new Promise((done) => ready.close(done));
	}
});

test('the output tail keeps the last lines, partial line included', () => {
	const tail = new OutputTail(3);
	tail.push('a\nb\n');
	tail.push('c\r\nd\ne');
	tail.push('nd');
	expect(tail.text()).toBe('c\nd\nend');
});

test('book never writes where journey test keeps visual baselines', () => {
	const loaded: LoadedConfig = { config: { out: 'out' }, path: '/p/journey.config.ts', dir: '/p' };
	const out = outDir(loaded);
	const ids = ['create-note', 'book', 'pages', 'a'];
	const keys = ['desktop', 'desktop-light', 'book', 'create-note', 'mobile-dark-ja'];
	for (const id of ids) {
		for (const key of keys) {
			const written = relative(out, variantDir(bookRoot(loaded), id, key)).split(sep);
			expect(written[0]).toBe('book');
			for (const snapId of ids) {
				for (const snapKey of keys) {
					const baseline = join(out, snapId, snapKey, captureFile(0, 'x'));
					const rel = relative(variantDir(bookRoot(loaded), id, key), baseline);
					expect(rel.startsWith('..'), `${id}/${key} holds ${baseline}`).toBe(true);
				}
			}
		}
	}
});

async function statusServer(status: number): Promise<{ url: string; server: Server }> {
	const server = createHttpServer((_q, res) => {
		res.writeHead(status, status < 400 && status >= 300 ? { location: '/login' } : {});
		res.end();
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return { url: `http://127.0.0.1:${port}/`, server };
}

test('a ready URL answering any status below 500 is up', async () => {
	for (const [status, up] of [
		[200, true],
		[302, true],
		[401, true],
		[404, true],
		[500, false],
		[503, false],
	] as const) {
		const { url, server } = await statusServer(status);
		try {
			expect(await answers(url), String(status)).toBe(up);
		} finally {
			await new Promise((done) => server.close(done));
		}
	}
});

test('a server whose ready URL answers 404 starts', async () => {
	const { url, server } = await statusServer(404);
	try {
		const stop = await startCommand('exec sleep 30', {
			cwd: process.cwd(),
			ready: url,
			timeout: 3000,
		});
		await stop();
	} finally {
		await new Promise((done) => server.close(done));
	}
});

function fixtureContext(configDir: string): FixtureContext {
	return { baseUrl: 'http://127.0.0.1:9/', configDir } as FixtureContext;
}

test('a fixture command without ready runs to completion before the journey', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-fixture-'));
	try {
		const config = {
			app: { url: 'http://127.0.0.1:9/', timeout: 5000 },
			fixtures: { seed: { command: 'sleep 0.3 && touch seeded' } },
		};
		const applied = await applyFixture('seed', config, fixtureContext(dir));
		expect(existsSync(join(dir, 'seeded'))).toBe(true);
		await applied.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a fixture command without ready must exit 0, and reports its output', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-fixture-'));
	try {
		const failing = {
			app: { url: 'http://127.0.0.1:9/', timeout: 5000 },
			fixtures: { seed: { command: 'echo "seed: no database" >&2; exit 2' } },
		};
		await expect(applyFixture('seed', failing, fixtureContext(dir))).rejects.toThrow(
			/"echo .*" exited with code 2\nlast output of .*\nseed: no database/,
		);
		const stuck = {
			app: { url: 'http://127.0.0.1:9/', timeout: 800 },
			fixtures: { seed: { command: 'echo seeding; exec sleep 30' } },
		};
		const started = Date.now();
		await expect(applyFixture('seed', stuck, fixtureContext(dir))).rejects.toThrow(
			/did not exit within 800 ms\nlast output of .*\nseeding/,
		);
		expect(Date.now() - started).toBeLessThan(5000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
