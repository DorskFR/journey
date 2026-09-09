import { expect, type Page, test } from '@playwright/test';
import type { Placement } from '../../src/runtime/overlay.js';
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

interface Geometry {
	caption: { top: number; left: number; right: number; bottom: number; width: number };
	target: { top: number; left: number; right: number; bottom: number } | null;
	view: { width: number; height: number };
}

async function showFirstStep(page: Page, placement: Placement): Promise<Geometry> {
	await driverLoad(page, createNoteIR, { ...defaultLoad, presenter: 'doc', placement });
	await driverStep(page);
	return page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const box = (rect: DOMRect) => ({
			top: rect.top,
			left: rect.left,
			right: rect.right,
			bottom: rect.bottom,
			width: rect.width,
		});
		const target = api.overlay.target();
		return {
			caption: box(api.overlay.parts.caption.getBoundingClientRect()),
			target: target ? box(target) : null,
			view: { width: window.innerWidth, height: window.innerHeight },
		};
	});
}

function overlaps(a: Geometry['caption'], b: NonNullable<Geometry['target']>): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	await waitForApi(page);
});

test('the banner spans the bottom of the viewport and clears the target', async ({ page }) => {
	const geometry = await showFirstStep(page, 'banner');
	expect(geometry.target).not.toBeNull();
	expect(geometry.caption.left).toBe(0);
	expect(geometry.caption.width).toBe(geometry.view.width);
	expect(geometry.caption.bottom).toBe(geometry.view.height);
	expect(overlaps(geometry.caption, geometry.target as NonNullable<Geometry['target']>)).toBe(
		false,
	);
});

test('anchored placement still puts the caption beside the target', async ({ page }) => {
	const geometry = await showFirstStep(page, 'anchored');
	expect(geometry.target).not.toBeNull();
	expect(geometry.caption.width).toBeLessThan(geometry.view.width);
	expect(geometry.caption.top).toBeGreaterThan((geometry.target as { top: number }).top);
});

test('the banner is themed from its own tokens', async ({ page }) => {
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--journey-banner-surface', 'rgba(1, 2, 3, 0.5)');
		document.documentElement.style.setProperty('--journey-banner-text', '#00ff00');
	});
	await showFirstStep(page, 'banner');
	const style = await page.evaluate(() => {
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const css = getComputedStyle(api.overlay.parts.caption);
		return { background: css.backgroundColor, color: css.color };
	});
	expect(style.background).toBe('rgba(1, 2, 3, 0.5)');
	expect(style.color).toBe('rgb(0, 255, 0)');
});

test('--journey-z takes the overlay out of the top layer and into normal stacking', async ({
	page,
}) => {
	const state = () =>
		page.evaluate(() => {
			const { host } = (window.__journey as NonNullable<typeof window.__journey>).overlay;
			return { top: host.matches(':popover-open'), z: host.style.zIndex };
		});

	expect(await state()).toEqual({ top: true, z: '' });

	await page.evaluate(() => {
		document.documentElement.style.setProperty('--journey-z', '5');
		(window.__journey as NonNullable<typeof window.__journey>).overlay.raise();
	});
	expect(await state()).toEqual({ top: false, z: '5' });
});
