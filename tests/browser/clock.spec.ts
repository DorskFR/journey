import { expect, test } from '@playwright/test';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, ir, waitForApi } from './helpers.js';

declare global {
	interface Window {
		__result?: RunResult;
	}
}

const EPOCH = new Date('2026-01-01T00:00:00Z').getTime();

test('step timeouts expire while the page clock is pinned', async ({ page }) => {
	await page.clock.setFixedTime(EPOCH);
	await page.goto(`${BASE}/?journey=guide`);
	await waitForApi(page);
	const journey = ir({
		id: 'pinned',
		route: '/#notes',
		steps: [{ id: 'never', expect: [{ visible: 'nope' }], timeout: 1000 }],
	});
	await page.evaluate((j) => window.__journey?.register([j]), journey);

	const started = performance.now();
	await page.evaluate(() => {
		window.__journey?.start('pinned', { mode: 'run' }).then((result) => {
			window.__result = result;
		});
	});
	await expect
		.poll(() => page.evaluate(() => window.__result), { timeout: 5000 })
		.toMatchObject({ ok: false, completed: 0 });
	expect(performance.now() - started).toBeLessThan(5000);
	expect(await page.evaluate(() => Date.now())).toBe(EPOCH);
});
