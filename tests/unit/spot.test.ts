import { expect, test } from '@playwright/test';
import { spotBox } from '../../src/runtime/overlay.js';

test('a target inside the viewport keeps its padded ring and corner badge', () => {
	expect(spotBox({ top: 100, left: 50, width: 200, height: 40 }, 800, 600)).toEqual({
		top: 94,
		left: 44,
		width: 212,
		height: 52,
		badgeTop: 81,
		badgeLeft: 31,
	});
});

test('a target taller than the viewport is cut at the viewport with the badge on screen', () => {
	const box = spotBox({ top: -400, left: 0, width: 390, height: 2000 }, 390, 844);
	expect(box.top).toBe(3);
	expect(box.left).toBe(3);
	expect(box.top + box.height).toBe(841);
	expect(box.left + box.width).toBe(387);
	expect(box.badgeTop).toBe(0);
	expect(box.badgeLeft).toBe(0);
});

test('the badge stays on screen for a target below the fold', () => {
	const box = spotBox({ top: 900, left: 10, width: 100, height: 100 }, 400, 600);
	expect(box.badgeTop).toBeLessThanOrEqual(574);
	expect(box.height).toBe(0);
});
