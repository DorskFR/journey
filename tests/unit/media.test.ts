import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
	pngSize,
	renderVtt,
	STORYBOARD_CELL_WIDTH,
	STORYBOARD_GAP,
	storyboardLayout,
} from '../../src/cli/media.js';

function png(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const chunk = (type: string, data: Buffer): Buffer => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
	};
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(Buffer.alloc(1))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

test('captions are a WebVTT track with one cue per captured say, held until the next', () => {
	const vtt = renderVtt(
		[
			{ at: 1200, title: 'Welcome', body: 'Your notes <live> here.' },
			{ at: 4000 },
			{ at: 61_500, title: 'ノートを保存', body: 'Save & close\n  it.' },
		],
		3_725_010,
	);
	expect(vtt).toBe(
		[
			'WEBVTT',
			'',
			'1',
			'00:00:01.200 --> 00:00:04.000',
			'Welcome',
			'Your notes &lt;live&gt; here.',
			'',
			'2',
			'00:01:01.500 --> 01:02:05.010',
			'ノートを保存',
			'Save &amp; close',
			'it.',
			'',
		].join('\n'),
	);
	expect(renderVtt([{ at: 0 }], 1000)).toBeNull();
	expect(renderVtt([{ at: 900, body: 'Last' }], 900)).toContain('00:00:00.900 --> 00:00:00.901');
});

test('the storyboard letterboxes each capture in its own aspect ratio', () => {
	const layout = storyboardLayout([
		{ width: 1280, height: 800 },
		{ width: 300, height: 600 },
		{ width: 1000, height: 100 },
		{ width: 1280, height: 800 },
	]);
	const cellHeight = (STORYBOARD_CELL_WIDTH * 800) / 1280;
	expect(layout.cells.map((c) => c.height)).toEqual([250, 250, 250, 250]);
	expect(layout.height).toBe(2 * cellHeight + 3 * STORYBOARD_GAP);
	const [full, tall, wide, second] = layout.cells;
	expect(full?.image).toEqual({ x: full?.x, y: full?.y, width: 400, height: 250 });
	expect(tall?.image.height).toBe(250);
	expect(tall?.image.width).toBe(125);
	expect(tall?.image.x).toBe((tall?.x ?? 0) + Math.round((400 - 125) / 2));
	expect(wide?.image.width).toBe(400);
	expect(wide?.image.height).toBe(40);
	expect(wide?.image.y).toBe((wide?.y ?? 0) + (250 - 40) / 2);
	expect(second?.y).toBe(STORYBOARD_GAP * 2 + cellHeight);
});

test('png sizes come from the IHDR header', () => {
	expect(pngSize(png(321, 123))).toEqual({ width: 321, height: 123 });
	expect(() => pngSize(Buffer.from('not a png at all, really not'))).toThrow('not a PNG');
});
