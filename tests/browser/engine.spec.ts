import { expect, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, createNoteIR, ir, pixelAt, waitForApi } from './helpers.js';

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

async function clickSpotlight(page: Page): Promise<void> {
	const rect = await page.evaluate(() => {
		const r = window.__journey?.overlay.target();
		return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	});
	if (!rect) throw new Error('no spotlight target');
	await page.mouse.click(rect.x, rect.y);
}

const card = (page: Page) => page.locator('journey-overlay .card');

test.beforeEach(async ({ page }) => {
	await page.goto(`${BASE}/?journey=guide`);
	await register(page, [createNoteIR]);
});

test('guide mode with a simulated human', async ({ page }) => {
	await start(page, 'create-note', { params: PARAMS });
	await expect(card(page)).toContainText('Step 1 of 5');
	await expect(card(page)).toContainText('Welcome');
	await clickSpotlight(page);
	await expect(card(page)).toContainText('Step 2 of 5');
	await clickSpotlight(page);
	await expect(card(page)).toContainText('Step 3 of 5');

	const dialog = page.locator('[data-journey="dialog"]');
	await expect(dialog).toBeVisible();
	const centre = await page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const spot = api.overlay.parts.spot;
		const rect = api.overlay.target() as DOMRect;
		Object.assign(spot.style, { background: 'rgb(255, 0, 255)', pointerEvents: 'auto' });
		return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
	});
	await expect
		.poll(() => pixelAt(page, centre.x, centre.y), { timeout: 5000 })
		.toEqual([255, 0, 255]);
	await page.evaluate(() => {
		const spot = (window.__journey as NonNullable<typeof window.__journey>).overlay.parts.spot;
		Object.assign(spot.style, { background: '', pointerEvents: '' });
	});

	await page.locator('[data-journey="title"]').fill('Buy milk');
	await expect(card(page)).toContainText('Step 4 of 5');
	await page.locator('[data-journey="category"]').selectOption('idea');
	await expect(card(page)).toContainText('Step 5 of 5');
	await clickSpotlight(page);
	await expect.poll(() => result(page)).toEqual({ ok: true, completed: 5, failures: [] });
	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
	await expect(card(page)).toBeHidden();
});

test('Next advances a none step and Escape aborts', async ({ page }) => {
	await register(page, [
		ir({
			id: 'intro',
			steps: [
				{ id: 'hello', say: { title: 'Hello' } },
				{ id: 'go', target: 'start', do: { kind: 'click' }, say: { title: 'Go' } },
			],
		}),
	]);
	await start(page, 'intro');
	await expect(card(page)).toContainText('Step 1 of 2');
	await card(page).locator('button.next').click();
	await expect(card(page)).toContainText('Step 2 of 2');
	expect(await page.evaluate(() => window.__journey?.current())).toEqual({ id: 'intro', index: 1 });
	await page.keyboard.press('Escape');
	await expect.poll(() => result(page)).toMatchObject({ ok: false, aborted: true, completed: 1 });
	await expect(card(page)).toBeHidden();
	expect(await page.evaluate(() => window.__journey?.current())).toBeNull();
});

test('progress resumes after a reload', async ({ page }) => {
	await start(page, 'create-note', { params: PARAMS });
	await expect(card(page)).toContainText('Step 1 of 5');
	await clickSpotlight(page);
	await expect(card(page)).toContainText('Step 2 of 5');
	await page.reload();
	await register(page, [createNoteIR]);
	await expect(card(page)).toContainText('Step 2 of 5');
	expect(await page.evaluate(() => window.__journey?.current())).toEqual({
		id: 'create-note',
		index: 1,
	});
});

test('optional steps skip when the target is missing', async ({ page }) => {
	await register(page, [
		ir({
			id: 'optional',
			steps: [
				{ id: 'missing', target: 'nope', do: { kind: 'click' }, optional: true, timeout: 300 },
				{ id: 'present', target: 'start', do: { kind: 'click' }, expect: [{ url: '/#notes' }] },
			],
		}),
	]);
	await start(page, 'optional', { mode: 'run' });
	await expect.poll(() => result(page)).toEqual({ ok: true, completed: 1, failures: [] });
});

test('a failing expectation reports the observed state', async ({ page }) => {
	await register(page, [
		ir({
			id: 'wrong',
			route: '/#notes',
			steps: [
				{ id: 'open', route: '/#notes', expect: [{ visible: 'notes' }] },
				{ id: 'count', expect: [{ count: ['notes/note', { equals: 5 }] }], timeout: 300 },
			],
		}),
	]);
	await start(page, 'wrong', { mode: 'run' });
	await expect
		.poll(() => result(page))
		.toEqual({
			ok: false,
			completed: 1,
			failures: [{ stepId: 'count', error: 'count notes/note: 3' }],
		});
});

test('preview waits for Next before each step', async ({ page }) => {
	await register(page, [
		ir({
			id: 'stepped',
			steps: [
				{ id: 'go', target: 'start', do: { kind: 'click' } },
				{ id: 'new', target: 'notes/new', do: { kind: 'click' }, expect: [{ visible: 'dialog' }] },
			],
		}),
	]);
	await start(page, 'stepped', { mode: 'preview' });
	await expect(card(page)).toContainText('Step 1 of 2');
	await expect(card(page).locator('button.next')).toBeVisible();
	await expect(page.locator('[data-journey="notes"]')).toBeHidden();
	await expect(card(page)).toContainText('Step 1 of 2');
	await page.keyboard.press('Enter');
	await expect(card(page)).toContainText('Step 2 of 2');
	await expect(page.locator('[data-journey="notes"]')).toBeVisible();
	await expect(page.locator('[data-journey="dialog"]')).toBeHidden();
	await card(page).locator('button.next').click();
	await expect.poll(() => result(page)).toEqual({ ok: true, completed: 2, failures: [] });
	await expect(page.locator('[data-journey="dialog"]')).toBeVisible();
});
