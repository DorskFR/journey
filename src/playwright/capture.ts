import type { Page } from '@playwright/test';
import type { Capture } from '../core/types.js';
import type { CaptureContext, Rect } from './driver.js';

export const CROP_PADDING = 24;

export function clipRect(rect: Rect, viewport: { width: number; height: number }): Rect {
	const x = Math.max(0, rect.x - CROP_PADDING);
	const y = Math.max(0, rect.y - CROP_PADDING);
	const right = Math.min(viewport.width, rect.x + rect.width + CROP_PADDING);
	const bottom = Math.min(viewport.height, rect.y + rect.height + CROP_PADDING);
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export async function captureStep(page: Page, spec: Capture, ctx: CaptureContext): Promise<Buffer> {
	const crop = spec.crop ?? 'none';
	if (crop === 'none' || !ctx.rect) return page.screenshot({ type: 'png' });
	const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
	return page.screenshot({ type: 'png', clip: clipRect(ctx.rect, viewport) });
}

export async function startVideo(page: Page, path: string): Promise<() => Promise<void>> {
	await page.screencast.start({ path });
	return () => page.screencast.stop();
}
