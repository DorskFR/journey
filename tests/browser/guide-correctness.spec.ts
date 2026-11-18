import { expect, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, ir, waitForApi } from './helpers.js';

declare global {
	interface Window {
		__result?: RunResult;
	}
}

async function register(page: Page, journeys: IR[]): Promise<void> {
	await waitForApi(page);
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

const result = (page: Page) => page.evaluate(() => window.__result);
const current = (page: Page) => page.evaluate(() => window.__journey?.current() ?? null);
const card = (page: Page) => page.locator('journey-overlay .card');

test.beforeEach(async ({ page }) => {
	await page.goto(`${BASE}/?journey=guide`);
	await waitForApi(page);
});

test.describe('a step whose target is missing', () => {
	const missing = (timeout: number) =>
		ir({
			id: 'missing',
			steps: [
				{ id: 'hello', say: { title: 'Hello' } },
				{ id: 'lost', target: 'nope', do: { kind: 'click' }, say: { title: 'Lost' }, timeout },
			],
		});

	test('draws its card with Exit while the target is pending, and Escape exits', async ({
		page,
	}) => {
		await register(page, [missing(10000)]);
		await start(page, 'missing');
		await card(page).locator('button.next').click();
		await expect(card(page)).toContainText('Step 2 of 2');
		await expect(card(page)).toContainText('Lost');
		await expect(card(page).locator('button.next')).toHaveCount(0);
		await expect(card(page).locator('button.exit')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect.poll(() => result(page)).toMatchObject({ ok: false, aborted: true });
		await expect(card(page)).toBeHidden();
	});

	test('ends the guide at the step timeout and is not resumed after a reload', async ({ page }) => {
		await register(page, [missing(500)]);
		await start(page, 'missing', { from: 1 });
		await expect(card(page)).toContainText('Step 2 of 2');
		await expect
			.poll(() => result(page))
			.toEqual({
				ok: false,
				completed: 0,
				failures: [{ stepId: 'lost', error: 'target nope: 0 matches after 500ms' }],
			});
		await expect(card(page)).toBeHidden();
		await page.reload();
		await register(page, [missing(500)]);
		expect(await current(page)).toBeNull();
		await expect(card(page)).toBeHidden();
	});

	test('re-resolves a target the page replaced after it was shown', async ({ page }) => {
		await page.evaluate(() => {
			const b = document.createElement('button');
			b.dataset.journey = 'swap';
			b.textContent = 'Swap me';
			document.body.prepend(b);
		});
		await register(page, [
			ir({
				id: 'swap',
				steps: [{ id: 'press', target: 'swap', do: { kind: 'click' }, say: { title: 'Press' } }],
			}),
		]);
		await start(page, 'swap');
		await expect(card(page)).toContainText('Press');
		await page.evaluate(() => {
			const old = document.querySelector('[data-journey="swap"]') as Element;
			old.replaceWith(old.cloneNode(true));
		});
		await page.waitForTimeout(300);
		await page.locator('[data-journey="swap"]').click();
		await expect.poll(() => result(page)).toEqual({ ok: true, completed: 1, failures: [] });
	});
});

test.describe('Escape', () => {
	test('passes a step whose action is pressing Escape instead of exiting', async ({ page }) => {
		await register(page, [
			ir({
				id: 'esc',
				steps: [
					{ id: 'start', target: 'start', do: { kind: 'click' } },
					{ id: 'close', target: 'search', do: { kind: 'press', key: 'Escape' } },
				],
			}),
		]);
		await page.evaluate(() => {
			location.hash = '#notes';
		});
		await start(page, 'esc', { from: 1 });
		await expect(card(page)).toContainText('Step 2 of 2');
		await expect(card(page).locator('button.exit kbd')).toHaveCount(0);
		await page.locator('[data-journey="search"]').press('Escape');
		await expect.poll(() => result(page)).toEqual({ ok: true, completed: 1, failures: [] });
	});

	test('closing a host dialog with Escape keeps the guide, a later Escape exits', async ({
		page,
	}) => {
		await page.evaluate(() => {
			const dialog = document.createElement('dialog');
			dialog.dataset.journey = 'host-dialog';
			dialog.innerHTML = '<button type="button">Inside</button>';
			document.body.append(dialog);
		});
		await register(page, [ir({ id: 'tour', steps: [{ id: 'hello', say: { title: 'Hello' } }] })]);
		await start(page, 'tour');
		await expect(card(page)).toContainText('Hello');
		await page.evaluate(() => {
			(document.querySelector('[data-journey="host-dialog"]') as HTMLDialogElement).showModal();
		});
		await page.locator('[data-journey="host-dialog"] > button').focus();
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-journey="host-dialog"]')).toBeHidden();
		expect(await current(page)).toEqual({ id: 'tour', index: 0 });
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.keyboard.press('Escape');
		await expect.poll(() => result(page)).toMatchObject({ ok: false, aborted: true });
	});

	test('an Escape the host handled does not exit the guide', async ({ page }) => {
		await page.evaluate(() => {
			document.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') event.preventDefault();
			});
		});
		await register(page, [ir({ id: 'tour', steps: [{ id: 'hello', say: { title: 'Hello' } }] })]);
		await start(page, 'tour');
		await expect(card(page)).toContainText('Hello');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);
		expect(await current(page)).toEqual({ id: 'tour', index: 0 });
	});

	test('an open menu takes Escape', async ({ page }) => {
		await page.evaluate(() => {
			const menu = document.createElement('div');
			menu.setAttribute('role', 'menu');
			menu.innerHTML = '<button type="button" role="menuitem">Item</button>';
			document.body.prepend(menu);
		});
		await register(page, [ir({ id: 'tour', steps: [{ id: 'hello', say: { title: 'Hello' } }] })]);
		await start(page, 'tour');
		await expect(card(page)).toContainText('Hello');
		await page.locator('[role="menuitem"]').focus();
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);
		expect(await current(page)).toEqual({ id: 'tour', index: 0 });
	});
});
