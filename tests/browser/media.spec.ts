import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { STORYBOARD_CELL_WIDTH, STORYBOARD_GAP, storyboard } from '../../src/cli/media.js';

async function solid(page: Page, file: string, width: number, height: number, color: string) {
	await page.setViewportSize({ width, height });
	await page.setContent(`<body style="margin:0;background:${color}"></body>`);
	writeFileSync(file, await page.screenshot({ type: 'png' }));
}

async function pixel(page: Page, png: string, x: number, y: number): Promise<number[]> {
	return page.evaluate(
		async ([src, px, py]) => {
			const img = new Image();
			img.src = src;
			await img.decode();
			const canvas = document.createElement('canvas');
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
			ctx.drawImage(img, 0, 0);
			return Array.from(ctx.getImageData(px, py, 1, 1).data.slice(0, 3));
		},
		[`data:image/png;base64,${readFileSync(png).toString('base64')}`, x, y] as const,
	);
}

test('the storyboard keeps the aspect ratio of a cropped capture next to full ones', async ({
	page,
	browser,
}) => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-storyboard-'));
	try {
		const full = join(dir, 'full.png');
		const tall = join(dir, 'tall.png');
		await solid(page, full, 1280, 800, 'rgb(255,0,0)');
		await solid(page, tall, 200, 600, 'rgb(0,0,255)');
		const out = join(dir, 'storyboard.png');
		await storyboard([full, tall], out, browser);

		const cellHeight = (STORYBOARD_CELL_WIDTH * 800) / 1280;
		const cellX = STORYBOARD_GAP * 2 + STORYBOARD_CELL_WIDTH;
		const midY = STORYBOARD_GAP + cellHeight / 2;
		expect(await pixel(page, out, STORYBOARD_GAP + 200, midY)).toEqual([255, 0, 0]);
		expect(await pixel(page, out, cellX + STORYBOARD_CELL_WIDTH / 2, midY)).toEqual([0, 0, 255]);
		expect(await pixel(page, out, cellX + 40, midY)).toEqual([238, 238, 238]);
		expect(await pixel(page, out, cellX + STORYBOARD_CELL_WIDTH - 40, midY)).toEqual([
			238, 238, 238,
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
