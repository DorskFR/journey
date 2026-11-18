import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import { BASE, RUNTIME_INIT, waitForApi } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

const card = (page: Page) => page.locator('journey-overlay .card');

const JOURNEY: Journey = {
	id: 'stored',
	version: 1,
	route: '/',
	autostart: { route: '/', once: true },
	steps: [
		{ id: 'one', say: { title: 'One', body: 'First.' } },
		{ id: 'two', say: { title: 'Two', body: 'Second.' } },
	],
};

async function mountWithMemoryStore(page: Page): Promise<void> {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const cell = new Map<string, string>();
		(window as unknown as { __store: Map<string, string> }).__store = cell;
		runtime.mount({
			storage: {
				get: async (key: string) => cell.get(key) ?? null,
				set: async (key: string, value: string) => {
					cell.set(key, value);
				},
				remove: async (key: string) => {
					cell.delete(key);
				},
			},
		});
	});
	await waitForApi(page);
}

function storeKeys(page: Page): Promise<string[]> {
	return page.evaluate(() => [
		...(window as unknown as { __store: Map<string, string> }).__store.keys(),
	]);
}

function browserKeys(page: Page): Promise<string[]> {
	return page.evaluate(() => [
		...Object.keys(sessionStorage).filter((k) => k.startsWith('journey:')),
		...Object.keys(localStorage).filter((k) => k.startsWith('journey:')),
	]);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
});

test('an async adapter takes both progress and the completion marker', async ({ page }) => {
	await mountWithMemoryStore(page);
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);

	await expect(card(page)).toContainText('One');
	await expect.poll(() => storeKeys(page)).toContain('journey:progress');

	await card(page).locator('button.next').click();
	await expect(card(page)).toContainText('Two');
	await card(page).locator('button.next').click();

	await expect.poll(() => storeKeys(page)).toContain('journey:done:stored@1');
	expect(await browserKeys(page)).toEqual([]);
});

test('the completion marker read from the adapter suppresses autostart', async ({ page }) => {
	await mountWithMemoryStore(page);
	await page.evaluate(() => {
		(window as unknown as { __store: Map<string, string> }).__store.set(
			'journey:done:stored@1',
			'1',
		);
	});
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);

	await page.waitForTimeout(500);
	await expect(card(page)).toBeHidden();
});

test('with no adapter the built-in keys are still used', async ({ page }) => {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		runtime.mount({});
	});
	await waitForApi(page);
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);

	await expect(card(page)).toContainText('One');
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('journey:progress') !== null))
		.toBe(true);
});

const SECRET: Journey = {
	id: 'secret',
	version: 1,
	route: '/',
	steps: [
		{ id: 'one', say: { title: 'One', body: 'First.' } },
		{
			id: 'query',
			target: 'start',
			do: { kind: 'fill', value: { $param: 'var.query' }, mask: true },
			say: { title: 'Query', body: 'Type it.' },
		},
	],
};

async function mountWithPageStore(page: Page): Promise<void> {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		runtime.mount({
			storage: {
				get: async (key: string) => localStorage.getItem(`store:${key}`),
				set: async (key: string, value: string) => localStorage.setItem(`store:${key}`, value),
				remove: async (key: string) => localStorage.removeItem(`store:${key}`),
			},
		});
	});
	await waitForApi(page);
}

const storedProgress = (page: Page) =>
	page.evaluate(() => localStorage.getItem('store:journey:progress'));

test('the adapter never receives secret params, and a resume takes them from register', async ({
	page,
}) => {
	await mountWithPageStore(page);
	await page.evaluate(async (journey) => {
		await window.__journey?.register([journey]);
		void window.__journey?.start('secret', {
			params: { 'var.query': 'hunter2', apiToken: 'tok-123', note: 'kept' },
		});
	}, SECRET);
	await expect(card(page)).toContainText('One');
	await card(page).locator('button.next').click();
	await expect(card(page)).toContainText('Query');
	await expect.poll(() => storedProgress(page)).toContain('"index":1');

	const raw = (await storedProgress(page)) ?? '';
	expect(raw).not.toContain('hunter2');
	expect(raw).not.toContain('tok-123');
	expect(JSON.parse(raw)).toMatchObject({ params: { note: 'kept' } });
	expect(JSON.parse(raw)).not.toHaveProperty('ir');
	expect(await page.evaluate(() => sessionStorage.getItem('journey:progress'))).toBeNull();

	await page.reload();
	await mountWithPageStore(page);
	await page.evaluate(
		(journey) => window.__journey?.register([journey], { params: { 'var.query': 'hunter2' } }),
		SECRET,
	);
	await expect(card(page)).toContainText('Query');
	expect(await page.evaluate(() => window.__journey?.current())).toEqual({
		id: 'secret',
		index: 1,
	});
	await page.evaluate(() => localStorage.clear());
});
