import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import { BASE, RUNTIME_INIT, waitForApi } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

const card = (page: Page) => page.locator('journey-overlay .card');

const JOURNEY: Journey = {
	id: 'nav-offer',
	version: 1,
	route: '/',
	steps: [
		{ id: 'here', say: { title: 'Here', body: 'Start on this page.' } },
		{ id: 'there', route: '/settings.html', say: { title: 'There', body: 'Now on settings.' } },
	],
};

async function mountWith(page: Page, hook: boolean): Promise<void> {
	await page.evaluate((useHook) => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		runtime.mount(
			useHook
				? {
						navigate: (route: string) => {
							history.pushState({}, '', route);
						},
					}
				: {},
		);
	}, hook);
	await waitForApi(page);
}

async function advanceToTheOffer(page: Page): Promise<void> {
	await page.evaluate((journey) => window.__journey?.register([journey]), JOURNEY);
	await page.evaluate(() => {
		void window.__journey?.start('nav-offer', { mode: 'guide' });
	});
	await expect(card(page)).toContainText('Here');
	await card(page).locator('button.next').click();
	await expect(card(page)).toContainText('Go to another page');
}

async function markAlive(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __alive?: boolean }).__alive = true;
	});
}

function stillAlive(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
});

test('the offer to navigate uses the host hook and keeps the page alive', async ({ page }) => {
	await mountWith(page, true);
	await advanceToTheOffer(page);
	await markAlive(page);

	const action = card(page).locator('button.next');
	await expect(action).toContainText('Take me there');
	await action.click();

	await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/settings.html');
	expect(await stillAlive(page)).toBe(true);
	await expect(card(page)).toContainText('There');
});

test('without a hook the offer falls back to a document navigation', async ({ page }) => {
	await mountWith(page, false);
	await advanceToTheOffer(page);
	await markAlive(page);

	await card(page).locator('button.next').click();

	await page.waitForURL(`${BASE}/settings.html`);
	expect(await stillAlive(page)).toBe(false);
});

test('the guide waits on the offer until it is taken', async ({ page }) => {
	await mountWith(page, true);
	await advanceToTheOffer(page);

	await page.waitForTimeout(500);
	await expect(card(page)).toContainText('Go to another page');
	expect(await page.evaluate(() => location.pathname)).toBe('/');
});
