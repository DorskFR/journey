import { expect, test } from '@playwright/test';
import type { Target } from '../../src/index.js';
import { BASE, RUNTIME_INIT } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

function count(page: import('@playwright/test').Page, target: Target): Promise<number> {
	return page.evaluate(
		(t) => (window as unknown as { journeyRuntime: Runtime }).journeyRuntime.resolveAll(t).length,
		target,
	);
}

function one(page: import('@playwright/test').Page, target: Target) {
	return page.evaluate((t) => {
		const r = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime.resolveOne(t);
		return r.error === undefined
			? { text: r.el.textContent?.trim(), label: r.el.getAttribute('aria-label') }
			: { error: r.error, count: 'count' in r ? r.count : undefined };
	}, target);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/#notes`);
	await expect(page.locator('[data-journey="notes"]')).toBeVisible();
});

test('resolves paths and keyed segments', async ({ page }) => {
	expect(await count(page, 'notes')).toBe(1);
	expect(await count(page, 'nav/to-notes')).toBe(1);
	await expect.poll(() => count(page, 'notes/note')).toBe(3);
	expect(await one(page, 'notes/note[2]/delete')).toEqual({
		text: 'Delete',
		label: 'Delete Water the plants',
	});
	expect(await one(page, 'notes/note[9]')).toEqual({ error: 'notfound', count: undefined });
});

test('identical Like buttons are ambiguous until nth picks one', async ({ page }) => {
	expect(await one(page, { css: '[data-journey=likes] button' })).toEqual({
		error: 'ambiguous',
		count: 6,
	});
	expect(await one(page, { css: '[data-journey=likes] button', nth: 2 })).toEqual({
		text: 'Like',
		label: null,
	});
});

test('role and name, label, and text fallbacks', async ({ page }) => {
	expect(await one(page, { role: 'button', name: 'Delete Plan the week' })).toEqual({
		text: 'Delete',
		label: 'Delete Plan the week',
	});
	expect(await one(page, { label: 'Search notes' })).toEqual({ text: '', label: 'Search notes' });
	expect(await one(page, { text: 'New note', within: 'notes' })).toEqual({
		text: 'New note',
		label: null,
	});
	expect(await one(page, { testid: 'version' })).toEqual({ text: 'demo 1.0', label: null });
});

test('hidden elements are not visible and count counts visible matches', async ({ page }) => {
	expect(await count(page, 'secret')).toBe(0);
	expect(await count(page, 'dialog')).toBe(0);
	await page.locator('[data-journey="reveal"]').click();
	expect(await count(page, 'secret')).toBe(1);
	await page.locator('[data-journey="search"]').fill('week');
	await expect.poll(() => count(page, 'notes/note')).toBe(1);
});
