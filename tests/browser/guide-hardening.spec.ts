import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, RUNTIME_INIT, waitForApi } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

declare global {
	interface Window {
		__result?: RunResult;
		__cell?: Map<string, string>;
		__resolvedAt?: number;
	}
}

const card = (page: Page) => page.locator('journey-overlay .card');

async function mount(page: Page, slowRemove = false): Promise<void> {
	await page.evaluate((slow) => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const cell = new Map<string, string>();
		window.__cell = cell;
		const later = (ms: number, work: () => void) =>
			new Promise<void>((resolve) =>
				setTimeout(() => {
					work();
					resolve();
				}, ms),
			);
		runtime.mount({
			storage: {
				get: async (key) => cell.get(key) ?? null,
				set: (key, value) => later(0, () => cell.set(key, value)),
				remove: (key) => later(slow ? 80 : 0, () => cell.delete(key)),
			},
			track: (event) => {
				if (event === 'step:resolved') window.__resolvedAt = performance.now();
			},
		});
	}, slowRemove);
	await waitForApi(page);
}

async function register(page: Page, journeys: Journey[]): Promise<void> {
	await page.evaluate((list) => window.__journey?.register(list), journeys);
}

async function start(page: Page, id: string, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate(
		([journeyId, options]) => {
			window.__result = undefined;
			window.__journey?.start(journeyId, options).then((result) => {
				window.__result = result;
			});
		},
		[id, opts] as const,
	);
}

function result(page: Page): Promise<RunResult | undefined> {
	return page.evaluate(() => window.__result);
}

async function addHtml(page: Page, html: string): Promise<void> {
	await page.evaluate((markup) => {
		const box = document.createElement('div');
		box.id = 'fixture';
		box.innerHTML = markup;
		document.body.append(box);
	}, html);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
});

test('Space and ArrowRight on a page control go to that control, not to Next', async ({ page }) => {
	await mount(page);
	await addHtml(
		page,
		`<button id="pagebtn" onclick="this.dataset.pressed = (Number(this.dataset.pressed || 0) + 1)">Page</button>
		<div id="slider" role="slider" tabindex="0" aria-valuenow="1"
			onkeydown="if (event.key === 'ArrowRight') this.setAttribute('aria-valuenow', '2')"></div>`,
	);
	await register(page, [
		{
			id: 'keys',
			steps: [
				{ id: 'one', say: { title: 'One' } },
				{ id: 'two', say: { title: 'Two' } },
				{ id: 'three', say: { title: 'Three' } },
			],
		},
	]);
	await start(page, 'keys');
	await expect(card(page)).toContainText('Step 1 of 3');

	await page.locator('#pagebtn').focus();
	await page.keyboard.press(' ');
	await expect(page.locator('#pagebtn')).toHaveAttribute('data-pressed', '1');
	await page.locator('#slider').focus();
	await page.keyboard.press('ArrowRight');
	await expect(page.locator('#slider')).toHaveAttribute('aria-valuenow', '2');
	await expect(card(page)).toContainText('Step 1 of 3');

	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press('ArrowRight');
	await expect(card(page)).toContainText('Step 2 of 3');
	await page.keyboard.press(' ');
	await expect(card(page)).toContainText('Step 3 of 3');
});

test('a zero-width element is not a match, and a hidden checkbox is checked through its label', async ({
	page,
}) => {
	await mount(page);
	await addHtml(
		page,
		`<span data-journey="thin" style="display:inline-block;width:0;height:20px"></span>
		<label data-journey="agree-label"><input data-journey="agree" type="checkbox" style="display:none"> I agree</label>`,
	);
	await register(page, [
		{
			id: 'visibility',
			steps: [
				{ id: 'thin', expect: [{ hidden: 'thin' }], timeout: 300 },
				{
					id: 'agree',
					target: 'agree-label',
					do: { kind: 'click' },
					expect: [{ checked: ['agree', true] }],
					timeout: 1000,
				},
			],
		},
	]);
	await start(page, 'visibility', { mode: 'run' });
	await expect.poll(() => result(page)).toEqual({ ok: true, completed: 2, failures: [] });
});

test('a long wait for a target wakes on the DOM change instead of the next slow poll', async ({
	page,
}) => {
	await mount(page);
	await register(page, [
		{ id: 'late', steps: [{ id: 's', target: 'late', do: { kind: 'none' }, timeout: 10000 }] },
	]);
	await start(page, 'late', { mode: 'run' });
	await page.waitForTimeout(3500);
	const addedAt = await page.evaluate(() => {
		const el = document.createElement('div');
		el.dataset.journey = 'late';
		el.textContent = 'late';
		document.body.append(el);
		return performance.now();
	});
	await expect.poll(() => result(page)).toMatchObject({ ok: true });
	const resolvedAt = await page.evaluate(() => window.__resolvedAt ?? 0);
	expect(resolvedAt - addedAt).toBeLessThan(400);
});

test('a restarted guide keeps its progress when the old clear settles late', async ({ page }) => {
	await mount(page, true);
	await register(page, [
		{ id: 'a', steps: [{ id: 'a1', say: { title: 'A' } }, { id: 'a2' }] },
		{ id: 'b', steps: [{ id: 'b1', say: { title: 'B' } }, { id: 'b2' }] },
	]);
	await start(page, 'a');
	await expect(card(page)).toContainText('A');
	await start(page, 'b');
	await expect(card(page)).toContainText('B');
	await page.waitForTimeout(300);
	const stored = await page.evaluate(() => window.__cell?.get('journey:progress') ?? null);
	expect(JSON.parse(stored ?? 'null')).toMatchObject({ id: 'b', index: 0 });
});
