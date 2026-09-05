import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';

export const STORYBOARD_COLUMNS = 3;
export const STORYBOARD_CELL_WIDTH = 400;
export const STORYBOARD_GAP = 12;

const GIF_FILTER = 'fps=12,scale=800:-1:flags=lanczos';

export function hasFfmpeg(): boolean {
	try {
		return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
	} catch {
		return false;
	}
}

function ffmpeg(args: string[]): void {
	const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`journey: ffmpeg failed: ${result.stderr?.trim() || result.error?.message}`);
	}
}

export function toMp4(webm: string, mp4: string): void {
	ffmpeg([
		'-i',
		webm,
		'-c:v',
		'libx264',
		'-pix_fmt',
		'yuv420p',
		'-movflags',
		'+faststart',
		'-crf',
		'23',
		mp4,
	]);
}

export function toGif(webm: string, gif: string): void {
	const dir = mkdtempSync(join(tmpdir(), 'journey-gif-'));
	const palette = join(dir, 'palette.png');
	try {
		ffmpeg(['-i', webm, '-vf', `${GIF_FILTER},palettegen`, palette]);
		ffmpeg(['-i', webm, '-i', palette, '-lavfi', `${GIF_FILTER}[x];[x][1:v]paletteuse`, gif]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function dataUrl(file: string): string {
	return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

export async function storyboard(pngPaths: string[], out: string, browser: Browser): Promise<void> {
	if (!pngPaths.length) return;
	const page = await browser.newPage();
	try {
		await page.goto('about:blank');
		await page.evaluate(
			async ([urls, columns, cellWidth, gap]) => {
				const images = await Promise.all(
					urls.map(
						(src) =>
							new Promise<HTMLImageElement>((resolve, reject) => {
								const img = new Image();
								img.onload = () => resolve(img);
								img.onerror = () => reject(new Error('storyboard: image failed to load'));
								img.src = src;
							}),
					),
				);
				const first = images[0] as HTMLImageElement;
				const cellHeight = Math.round((cellWidth * first.naturalHeight) / first.naturalWidth);
				const rows = Math.ceil(images.length / columns);
				const canvas = document.createElement('canvas');
				canvas.id = 'storyboard';
				canvas.width = columns * cellWidth + (columns + 1) * gap;
				canvas.height = rows * cellHeight + (rows + 1) * gap;
				canvas.style.display = 'block';
				document.body.style.margin = '0';
				document.body.append(canvas);
				const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
				ctx.fillStyle = '#fff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				images.forEach((img, i) => {
					const x = gap + (i % columns) * (cellWidth + gap);
					const y = gap + Math.floor(i / columns) * (cellHeight + gap);
					ctx.drawImage(img, x, y, cellWidth, cellHeight);
					ctx.beginPath();
					ctx.arc(x + 20, y + 20, 14, 0, Math.PI * 2);
					ctx.fillStyle = '#ffd166';
					ctx.fill();
					ctx.fillStyle = '#111';
					ctx.font = 'bold 14px system-ui';
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(String(i + 1), x + 20, y + 21);
				});
			},
			[pngPaths.map(dataUrl), STORYBOARD_COLUMNS, STORYBOARD_CELL_WIDTH, STORYBOARD_GAP] as const,
		);
		await page.locator('#storyboard').screenshot({ path: out, type: 'png' });
	} finally {
		await page.close();
	}
}
