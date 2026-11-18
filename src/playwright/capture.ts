import type { Page } from '@playwright/test';
import type { Capture } from '../core/types.js';
import type { CaptureContext, Rect } from './driver.js';

export const CROP_PADDING = 24;
export const SCREENSHOT_RETRIES = 2;
export const SCREENSHOT_RETRY_DELAY = 100;

const TRANSIENT_SCREENSHOT = /Unable to capture screenshot/;

type ScreenshotOptions = NonNullable<Parameters<Page['screenshot']>[0]>;

export function clipRect(rect: Rect, viewport: { width: number; height: number }): Rect {
	const x = Math.max(0, rect.x - CROP_PADDING);
	const y = Math.max(0, rect.y - CROP_PADDING);
	const right = Math.min(viewport.width, rect.x + rect.width + CROP_PADDING);
	const bottom = Math.min(viewport.height, rect.y + rect.height + CROP_PADDING);
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export async function retryScreenshot(
	page: Pick<Page, 'screenshot' | 'waitForTimeout'>,
	opts: ScreenshotOptions,
): Promise<Buffer> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await page.screenshot(opts);
		} catch (error) {
			const transient = error instanceof Error && TRANSIENT_SCREENSHOT.test(error.message);
			if (!transient || attempt >= SCREENSHOT_RETRIES) throw error;
			await page.waitForTimeout(SCREENSHOT_RETRY_DELAY);
		}
	}
}

export async function captureStep(page: Page, spec: Capture, ctx: CaptureContext): Promise<Buffer> {
	const crop = spec.crop ?? 'none';
	if (crop === 'none' || !ctx.rect) return retryScreenshot(page, { type: 'png' });
	const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
	return retryScreenshot(page, { type: 'png', clip: clipRect(ctx.rect, viewport) });
}

export async function startVideo(
	page: Page,
	path: string,
	size?: { width: number; height: number },
): Promise<() => Promise<void>> {
	await page.screencast.start(size ? { path, size } : { path });
	return () => page.screencast.stop();
}
