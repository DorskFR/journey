import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import { BASE, RUNTIME_INIT, waitForApi } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

type Call = { method: 'show' | 'settle' | 'hide'; step?: string; index?: number; total?: number };

const JOURNEY: Journey = {
	id: 'hosted',
	version: 1,
	route: '/',
	steps: [
		{ id: 'one', say: { title: 'One', body: 'First.' } },
		{ id: 'two', say: { title: 'Two', body: 'Second.' } },
	],
};

function calls(page: Page): Promise<Call[]> {
	return page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
}

function visibleParts(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const host = document.querySelector('journey-overlay');
		const root = host?.shadowRoot;
		if (!root) return [];
		return [...root.querySelectorAll('[part]')]
			.filter((el) => !(el as HTMLElement).hidden && el.getAttribute('part') !== 'panel')
			.map((el) => el.getAttribute('part') ?? '');
	});
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
});

test('a host presenter receives every step and the built-in overlay draws nothing', async ({
	page,
}) => {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const log: Call[] = [];
		(window as unknown as { __calls: Call[] }).__calls = log;
		let advance: (() => void) | null = null;
		(window as unknown as { __next: () => void }).__next = () => advance?.();
		runtime.mount({
			presenter: {
				show(step, _el, ctx) {
					log.push({ method: 'show', step: step.id, index: ctx.index, total: ctx.total });
					advance = ctx.next;
				},
				settle(step) {
					log.push({ method: 'settle', step: step.id });
				},
				hide() {
					log.push({ method: 'hide' });
				},
			},
		});
	});
	await waitForApi(page);
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);
	await page.evaluate(() => {
		(window as unknown as { __run: Promise<unknown> }).__run = window.__journey?.start(
			'hosted',
		) as Promise<unknown>;
	});

	await expect
		.poll(() => calls(page))
		.toContainEqual({
			method: 'show',
			step: 'one',
			index: 0,
			total: 2,
		});
	expect(await visibleParts(page)).toEqual([]);
	await page.evaluate(() => (window as unknown as { __next: () => void }).__next());
	await expect
		.poll(() => calls(page))
		.toContainEqual({
			method: 'show',
			step: 'two',
			index: 1,
			total: 2,
		});
	await page.evaluate(() => (window as unknown as { __next: () => void }).__next());
	await page.evaluate(() => (window as unknown as { __run: Promise<unknown> }).__run);

	expect(await calls(page)).toEqual([
		{ method: 'show', step: 'one', index: 0, total: 2 },
		{ method: 'settle', step: 'one' },
		{ method: 'show', step: 'two', index: 1, total: 2 },
		{ method: 'settle', step: 'two' },
		{ method: 'hide' },
	]);
	expect(await visibleParts(page)).toEqual([]);
	await expect(page.locator('journey-overlay .card')).toBeHidden();
});

test('a factory is asked by name and can keep run mode silent', async ({ page }) => {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const names: string[] = [];
		(window as unknown as { __names: string[] }).__names = names;
		runtime.mount({
			presenter: (name) => {
				names.push(name);
				return runtime.nonePresenter;
			},
		});
	});
	await waitForApi(page);
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);
	await page.evaluate(() => window.__journey?.start('hosted', { mode: 'run' }));
	expect(await page.evaluate(() => (window as unknown as { __names: string[] }).__names)).toContain(
		'none',
	);
});

test('without the option the built-in card still renders', async ({ page }) => {
	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		runtime.mount({});
	});
	await waitForApi(page);
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);
	await page.evaluate(() => void window.__journey?.start('hosted'));

	const card = page.locator('journey-overlay .card');
	await expect(card).toContainText('One');
	expect(await visibleParts(page)).toEqual(['card']);
	await card.locator('button.next').click();
	await expect(card).toContainText('Two');
});
