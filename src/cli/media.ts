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

export interface Size {
	width: number;
	height: number;
}

export function pngSize(png: Buffer): Size {
	if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') {
		throw new Error('journey: storyboard: not a PNG');
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export interface Cell {
	x: number;
	y: number;
	width: number;
	height: number;
	image: { x: number; y: number; width: number; height: number };
}

export interface StoryboardLayout {
	width: number;
	height: number;
	cells: Cell[];
}

export function storyboardLayout(sizes: Size[]): StoryboardLayout {
	const columns = STORYBOARD_COLUMNS;
	const cellWidth = STORYBOARD_CELL_WIDTH;
	const gap = STORYBOARD_GAP;
	const largest = sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
	const cellHeight = Math.round((cellWidth * largest.height) / largest.width);
	const rows = Math.ceil(sizes.length / columns);
	const cells = sizes.map((size, i): Cell => {
		const x = gap + (i % columns) * (cellWidth + gap);
		const y = gap + Math.floor(i / columns) * (cellHeight + gap);
		const scale = Math.min(cellWidth / size.width, cellHeight / size.height);
		const width = Math.round(size.width * scale);
		const height = Math.round(size.height * scale);
		return {
			x,
			y,
			width: cellWidth,
			height: cellHeight,
			image: {
				x: x + Math.round((cellWidth - width) / 2),
				y: y + Math.round((cellHeight - height) / 2),
				width,
				height,
			},
		};
	});
	return {
		width: columns * cellWidth + (columns + 1) * gap,
		height: rows * cellHeight + (rows + 1) * gap,
		cells,
	};
}

export async function storyboard(pngPaths: string[], out: string, browser: Browser): Promise<void> {
	if (!pngPaths.length) return;
	const layout = storyboardLayout(pngPaths.map((file) => pngSize(readFileSync(file))));
	const page = await browser.newPage();
	try {
		await page.goto('about:blank');
		await page.evaluate(
			async ([urls, board]) => {
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
				const canvas = document.createElement('canvas');
				canvas.id = 'storyboard';
				canvas.width = board.width;
				canvas.height = board.height;
				canvas.style.display = 'block';
				document.body.style.margin = '0';
				document.body.append(canvas);
				const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
				ctx.fillStyle = '#fff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				images.forEach((img, i) => {
					const cell = board.cells[i] as (typeof board.cells)[number];
					const { x, y } = cell;
					ctx.fillStyle = '#eee';
					ctx.fillRect(x, y, cell.width, cell.height);
					ctx.drawImage(img, cell.image.x, cell.image.y, cell.image.width, cell.image.height);
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
			[pngPaths.map(dataUrl), layout] as const,
		);
		await page.locator('#storyboard').screenshot({ path: out, type: 'png' });
	} finally {
		await page.close();
	}
}

export interface CaptionMark {
	at: number;
	title?: string;
	body?: string;
}

function vttTime(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const h = Math.floor(total / 3600000);
	const m = Math.floor(total / 60000) % 60;
	const s = Math.floor(total / 1000) % 60;
	const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(total % 1000, 3)}`;
}

function cueText(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join('\n');
}

export function renderVtt(marks: CaptionMark[], end: number): string | null {
	const cues: string[] = [];
	marks.forEach((mark, i) => {
		const text = [mark.title, mark.body]
			.filter((part): part is string => !!part?.trim())
			.map(cueText)
			.join('\n');
		if (!text) return;
		const until = Math.max(marks[i + 1]?.at ?? end, mark.at + 1);
		cues.push(`${cues.length + 1}\n${vttTime(mark.at)} --> ${vttTime(until)}\n${text}`);
	});
	return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n` : null;
}
