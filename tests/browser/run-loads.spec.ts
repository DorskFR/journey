import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { compile } from '../../src/index.js';
import { applyStorageState, runJourney } from '../../src/playwright/index.js';
import { BASE } from './helpers.js';

const PAGE = `<!doctype html><html><body>
<a href="/loads/b.html" data-journey="next">next</a>
<script>
if (new URLSearchParams(location.search).get('journey') !== null) {
	journeyRuntime.mount({
		probes: {
			theme: () => document.documentElement.dataset.theme ?? 'unset',
			run: () => new URLSearchParams(location.search).get('journey'),
		},
		variants: { theme: (v) => { document.documentElement.dataset.theme = v; } },
	});
}
</script></body></html>`;

async function serveLoads(page: Page): Promise<void> {
	await page.route(`${BASE}/loads/**`, (route) =>
		route.fulfill({ contentType: 'text/html', body: PAGE }),
	);
}

const dark = [
	{ probe: 'theme', equals: 'dark' },
	{ probe: 'run', equals: 'run' },
];

const acrossLoads = compile({
	id: 'across-loads',
	version: 1,
	route: '/loads/a.html',
	steps: [
		{ id: 'first', expect: dark },
		{ id: 'click', target: 'next', do: { kind: 'click' }, expect: [{ url: '/loads/b.html' }] },
		{ id: 'after-click', expect: dark },
		{ id: 'route', route: '/loads/a.html', expect: dark },
		{ id: 'navigate', do: { kind: 'navigate', url: '/loads/b.html' }, expect: dark },
	],
});

test('run mode and variants hold on every document load of the run', async ({ page }) => {
	await serveLoads(page);
	const result = await runJourney(page, acrossLoads, {
		baseUrl: BASE,
		variant: { viewport: 'desktop', theme: 'dark' },
	});
	expect(result).toEqual({ ok: true, completed: 5, failures: [] });
	await page.goto(`${BASE}/loads/a.html`);
	expect(new URL(page.url()).search).toBe('');
	expect(await page.evaluate(() => sessionStorage.getItem('journey:run'))).toBeNull();
});

test('a viewport with no size fails the run instead of running at the default size', async ({
	page,
}) => {
	await expect(
		runJourney(page, acrossLoads, { baseUrl: BASE, variant: { viewport: 'tablet' } }),
	).rejects.toThrow('journey driver: viewport "tablet" has no size');
});

const keepsTheme = compile({
	id: 'keeps-theme',
	version: 1,
	route: '/settings.html',
	steps: [
		{
			id: 'theme',
			target: 'theme',
			do: { kind: 'select', value: 'dark' },
			expect: [{ probe: 'theme', equals: 'dark' }],
		},
		{ id: 'back', target: 'back', do: { kind: 'click' }, expect: [{ url: '/#notes' }] },
		{ id: 'kept', expect: [{ probe: 'theme', equals: 'dark' }] },
	],
});

test('storage state is applied once, so what the journey stores survives later loads', async ({
	page,
}) => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-storage-'));
	try {
		const file = join(dir, 'state.json');
		writeFileSync(
			file,
			JSON.stringify({
				cookies: [],
				origins: [{ origin: BASE, localStorage: [{ name: 'theme', value: 'light' }] }],
			}),
		);
		await applyStorageState(page.context(), file);
		await applyStorageState(page.context(), file);
		const result = await runJourney(page, keepsTheme, { baseUrl: BASE });
		expect(result).toEqual({ ok: true, completed: 3, failures: [] });
		await page.reload();
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
		await applyStorageState(page.context(), file);
		await page.reload();
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('storage state still seeds the first load of the run', async ({ page }) => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-storage-'));
	try {
		const file = join(dir, 'state.json');
		writeFileSync(
			file,
			JSON.stringify({
				origins: [{ origin: BASE, localStorage: [{ name: 'theme', value: 'dark' }] }],
			}),
		);
		await applyStorageState(page.context(), file);
		const seeded = compile({
			id: 'seeded',
			version: 1,
			route: '/settings.html',
			steps: [{ id: 'seeded', expect: [{ probe: 'theme', equals: 'dark' }] }],
		});
		expect(await runJourney(page, seeded, { baseUrl: BASE })).toEqual({
			ok: true,
			completed: 1,
			failures: [],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a reload keeps what the page stored over the storage state', async ({ page }) => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-storage-'));
	try {
		const file = join(dir, 'state.json');
		writeFileSync(
			file,
			JSON.stringify({
				origins: [{ origin: BASE, localStorage: [{ name: 'theme', value: 'light' }] }],
			}),
		);
		await applyStorageState(page.context(), file);
		await page.goto(`${BASE}/settings.html`);
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
		await page.evaluate(() => localStorage.setItem('theme', 'dark'));
		await page.reload();
		expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
