import { expect, type Page, test } from '@playwright/test';
import type { PartName } from '../../src/runtime/overlay.js';
import {
	BASE,
	createNoteIR,
	defaultLoad,
	driverLoad,
	driverStep,
	mountRuntime,
	RUNTIME_INIT,
	waitForApi,
} from './helpers.js';

function hitTest(page: Page, part: PartName): Promise<string> {
	return page.evaluate((name) => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const el = api.overlay.parts[name as 'card'];
		const rect = el.getBoundingClientRect();
		if (el.hidden || rect.width === 0) return 'hidden';
		const under = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		return under ? under.tagName.toLowerCase() : 'null';
	}, part);
}

async function show(page: Page, presenter: 'guide' | 'doc'): Promise<void> {
	await driverLoad(page, createNoteIR, { ...defaultLoad, presenter });
	await driverStep(page);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	await waitForApi(page);
});

test('the guide card does not take the pointer from the page underneath it', async ({ page }) => {
	await show(page, 'guide');
	expect(await hitTest(page, 'card')).not.toBe('journey-overlay');
});

test('a hover lands on the page even where the card covers it', async ({ page }) => {
	await show(page, 'guide');
	const hovered = await page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const rect = api.overlay.parts.card.getBoundingClientRect();
		const under = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		if (!under || under.tagName.toLowerCase() === 'journey-overlay') return 'overlay';
		let seen = 'nothing';
		under.addEventListener('pointerover', () => {
			seen = 'page';
		});
		under.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		return seen;
	});
	expect(hovered).toBe('page');
});

test('the card keeps its own buttons clickable', async ({ page }) => {
	await show(page, 'guide');
	const clickable = await page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const button = api.overlay.parts.card.querySelector('button');
		if (!button) return 'no button';
		const rect = button.getBoundingClientRect();
		const under = api.overlay.root.elementFromPoint(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
		);
		return under === button ? 'button' : (under?.tagName.toLowerCase() ?? 'null');
	});
	expect(clickable).toBe('button');
});

test('the ring, badge and caption never take the pointer', async ({ page }) => {
	await show(page, 'doc');
	for (const part of ['spot', 'badge', 'caption'] as const) {
		expect(await hitTest(page, part), part).not.toBe('journey-overlay');
	}
});

test('a host stylesheet cannot make the overlay swallow the page', async ({ page }) => {
	await page.evaluate(() => {
		const style = document.createElement('style');
		style.textContent = 'journey-overlay{pointer-events:auto}';
		document.head.append(style);
	});
	await show(page, 'doc');
	for (const part of ['spot', 'badge', 'caption'] as const) {
		expect(await hitTest(page, part), part).not.toBe('journey-overlay');
	}
});
