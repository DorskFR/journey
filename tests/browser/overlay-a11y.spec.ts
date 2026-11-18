import { expect, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, createNoteIR, ir, waitForApi } from './helpers.js';

declare global {
	interface Window {
		__result?: RunResult;
	}
}

const PARAMS = { 'var.title': 'Buy milk' };

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

function result(page: Page): Promise<RunResult | undefined> {
	return page.evaluate(() => window.__result);
}

const card = (page: Page) => page.locator('journey-overlay .card');

function focused(page: Page): Promise<string> {
	return page.evaluate(() => {
		let el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
		if (!el || el === document.body) return 'body';
		const tag = el.tagName.toLowerCase();
		const name = el.getAttribute('data-journey') ?? el.className;
		return name ? `${tag}.${name}` : tag;
	});
}

async function toDialog(page: Page): Promise<void> {
	await start(page, 'create-note', { params: PARAMS });
	await expect(card(page)).toContainText('Step 1 of 5');
	await page.locator('[data-journey="start"]').click();
	await expect(card(page)).toContainText('Step 2 of 5');
	await page.locator('[data-journey="new"]').click();
	await expect(card(page)).toContainText('Step 3 of 5');
	await expect(page.locator('dialog[data-journey="dialog"]')).toBeVisible();
	expect(await page.evaluate(() => document.querySelector('dialog')?.matches(':modal'))).toBe(true);
}

test.beforeEach(async ({ page }) => {
	await page.goto(`${BASE}/?journey=guide`);
	await register(page, [createNoteIR]);
});

test.describe('a host modal dialog', () => {
	test('the card Exit button takes a real click while the dialog is modal', async ({ page }) => {
		await toDialog(page);
		await card(page).locator('button.exit').click({ timeout: 3000 });
		await expect.poll(() => result(page)).toMatchObject({ ok: false, aborted: true });
		await expect(card(page)).toBeHidden();
	});

	test('the card Next button takes a real click while the dialog is modal', async ({ page }) => {
		await register(page, [
			ir({
				id: 'modal-next',
				steps: [
					{
						id: 'open',
						target: 'start',
						do: { kind: 'click' },
						expect: [{ visible: 'notes' }],
					},
					{ id: 'new', target: 'notes/new', do: { kind: 'click' } },
					{ id: 'read', target: 'dialog/title', say: { title: 'Read me' } },
					{ id: 'after', say: { title: 'Done' } },
				],
			}),
		]);
		await start(page, 'modal-next');
		await expect(card(page)).toContainText('Step 1 of 4');
		await page.locator('[data-journey="start"]').click();
		await expect(card(page)).toContainText('Step 2 of 4');
		await expect(page.locator('journey-overlay .spot')).toBeVisible();
		await page.locator('[data-journey="new"]').click();
		await expect(card(page)).toContainText('Read me');
		await card(page).locator('button.next').click({ timeout: 3000 });
		await expect(card(page)).toContainText('Done');
	});

	test('the overlay leaves the dialog when it closes and still draws', async ({ page }) => {
		await toDialog(page);
		await page.evaluate(() => document.querySelector('dialog')?.close());
		await expect
			.poll(() =>
				page.evaluate(() => document.querySelector('journey-overlay')?.parentElement?.tagName),
			)
			.toBe('HTML');
		expect(
			await page.evaluate(() =>
				document.querySelector('journey-overlay')?.matches(':popover-open'),
			),
		).toBe(true);
	});

	test('the overlay survives the host removing the open dialog', async ({ page }) => {
		await toDialog(page);
		await page.evaluate(() => document.querySelector('dialog')?.remove());
		await expect
			.poll(() => page.evaluate(() => document.querySelector('journey-overlay')?.isConnected))
			.toBe(true);
		await expect(card(page)).toBeVisible();
	});
});

test.describe('focus and labels', () => {
	test('a wait-for-user step after Next moves focus to its target, not the body', async ({
		page,
	}) => {
		await register(page, [
			ir({
				id: 'focus',
				steps: [
					{ id: 'hello', say: { title: 'Hello' } },
					{ id: 'go', target: 'start', do: { kind: 'click' }, say: { title: 'Go' } },
				],
			}),
		]);
		await start(page, 'focus');
		await expect(card(page)).toContainText('Hello');
		await expect.poll(() => focused(page)).toBe('button.next');
		await page.keyboard.press('Enter');
		await expect(card(page)).toContainText('Go');
		await expect.poll(() => focused(page)).toBe('button.start');
	});

	test('focus falls back to the card when the target cannot take focus', async ({ page }) => {
		await register(page, [
			ir({
				id: 'plain',
				steps: [
					{ id: 'hello', say: { title: 'Hello' } },
					{ id: 'look', target: 'start', do: { kind: 'hover' }, say: { title: 'Look' } },
				],
			}),
		]);
		await page.evaluate(() => {
			document.querySelector('[data-journey="start"]')?.setAttribute('disabled', '');
		});
		await start(page, 'plain');
		await card(page).locator('button.next').focus();
		await page.keyboard.press('Enter');
		await expect(card(page)).toContainText('Look');
		await expect.poll(() => focused(page)).toBe('div.card');
	});

	test('exit restores focus to where it was before the tour', async ({ page }) => {
		await register(page, [ir({ id: 'restore', steps: [{ id: 'hello', say: { title: 'Hi' } }] })]);
		await page.locator('[data-journey="start"]').focus();
		await start(page, 'restore');
		await expect.poll(() => focused(page)).toBe('button.next');
		await card(page).locator('button.exit').click();
		await expect(card(page)).toBeHidden();
		await expect.poll(() => focused(page)).toBe('button.start');
	});

	test('a title-less step drops the previous step label and describes the body', async ({
		page,
	}) => {
		await register(page, [
			ir({
				id: 'labels',
				steps: [
					{ id: 'one', say: { title: 'First', body: 'Body one' } },
					{ id: 'two', say: { body: 'Body two' } },
				],
			}),
		]);
		await start(page, 'labels');
		await expect(card(page)).toHaveAttribute('aria-label', 'First');
		await expect(card(page)).toHaveAccessibleDescription('Body one');
		await card(page).locator('button.next').click();
		await expect(card(page)).toContainText('Body two');
		await expect(card(page)).not.toHaveAttribute('aria-label');
		await expect(card(page)).toHaveAccessibleDescription('Body two');
	});
});

test('reduced motion turns off the spot, cursor and ripple motion', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const styles = await page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const { spot, cursor, ripple } = api.overlay.parts;
		ripple.classList.add('on');
		return {
			spot: getComputedStyle(spot).transitionDuration,
			cursor: getComputedStyle(cursor).transitionDuration,
			ripple: getComputedStyle(ripple).animationName,
		};
	});
	expect(styles).toEqual({ spot: '0s', cursor: '0s', ripple: 'none' });
});
