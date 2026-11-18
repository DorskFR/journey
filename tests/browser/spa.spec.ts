import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import { BASE, RUNTIME_INIT, waitForApi } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');
type Options = import('../../src/runtime/index.js').MountOptions;

const card = (page: Page) => page.locator('journey-overlay .card');

async function mount(page: Page, options: Options = {}): Promise<void> {
	await page.evaluate((opts) => {
		(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.mount(opts);
	}, options);
	await waitForApi(page);
}

function register(page: Page, journeys: Journey[]) {
	return page.evaluate((list) => window.__journey?.register(list), journeys);
}

const pushState = (page: Page, url: string) =>
	page.evaluate((u) => history.pushState({}, '', u), url);

const tour = (route: string, once = false): Journey => ({
	id: 'tour',
	version: 1,
	route,
	autostart: { route, once },
	steps: [{ id: 'hello', say: { title: 'Hello', body: 'Welcome.' } }],
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => localStorage.clear());
});

for (const api of ['navigation', 'history'] as const) {
	test.describe(`autostart on client-side navigation (${api})`, () => {
		test.beforeEach(async ({ context, page }) => {
			if (api === 'history') {
				await context.addInitScript(() => {
					Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });
				});
			}
			await context.addInitScript(RUNTIME_INIT);
			await page.goto(`${BASE}/`);
		});

		test('pushState onto the autostart route starts the guide', async ({ page }) => {
			await mount(page);
			await register(page, [tour('/dashboard')]);
			await page.waitForTimeout(200);
			await expect(card(page)).toBeHidden();
			await pushState(page, '/dashboard');
			await expect(card(page)).toContainText('Hello');
		});

		test('replaceState and back navigation start the guide', async ({ page }) => {
			await mount(page);
			await register(page, [tour('/dashboard')]);
			await page.evaluate(() => history.replaceState({}, '', '/dashboard'));
			await expect(card(page)).toContainText('Hello');
			await card(page).locator('button.exit').click();
			await pushState(page, '/other');
			await page.goBack();
			await expect(card(page)).toContainText('Hello');
		});

		test('a hash route autostarts', async ({ page }) => {
			await mount(page);
			await register(page, [tour('/#notes')]);
			await page.evaluate(() => {
				location.hash = 'notes';
			});
			await expect(card(page)).toContainText('Hello');
		});

		test('a once guide that was exited does not start again on navigation', async ({ page }) => {
			await mount(page);
			await register(page, [tour('/dashboard', true)]);
			await pushState(page, '/dashboard');
			await card(page).locator('button.exit').click();
			await expect
				.poll(() => page.evaluate(() => localStorage.getItem('journey:done:tour@1')))
				.toBe('1');
			await pushState(page, '/');
			await pushState(page, '/dashboard');
			await page.waitForTimeout(300);
			await expect(card(page)).toBeHidden();
		});

		test('unmount stops watching navigation', async ({ page }) => {
			const native = await page.evaluate(() => history.pushState.toString());
			await mount(page);
			await register(page, [tour('/dashboard')]);
			await page.evaluate(() => window.__journey?.unmount());
			expect(await page.evaluate(() => history.pushState.toString())).toBe(native);
			await mount(page);
			await pushState(page, '/dashboard');
			await page.waitForTimeout(300);
			await expect(card(page)).toBeHidden();
		});
	});
}

test.describe('autostart routes', () => {
	test.beforeEach(async ({ context }) => {
		await context.addInitScript(RUNTIME_INIT);
	});

	test('landing on a hash route autostarts at register', async ({ page }) => {
		await page.goto(`${BASE}/#notes`);
		await mount(page);
		await register(page, [tour('/#notes')]);
		await expect(card(page)).toContainText('Hello');
	});

	test('a glob route matches like a url expectation', async ({ page }) => {
		await page.goto(`${BASE}/`);
		await mount(page);
		await register(page, [tour('/items/*')]);
		await pushState(page, '/items/42');
		await expect(card(page)).toContainText('Hello');
	});
});

const responsive: Journey = {
	id: 'responsive',
	version: 1,
	route: '/',
	steps: [
		{ id: 'phone', when: { viewport: 'mobile' }, say: { title: 'Phone', body: 'Tap.' } },
		{ id: 'desk', when: { viewport: 'desktop' }, say: { title: 'Desk', body: 'Click.' } },
		{ id: 'pad', when: { viewport: 'tablet' }, say: { title: 'Pad', body: 'Swipe.' } },
	],
};

test.describe('variant of an in-app guide', () => {
	test.beforeEach(async ({ context, page }) => {
		await context.addInitScript(RUNTIME_INIT);
		await page.goto(`${BASE}/`);
	});

	const startGuide = async (page: Page, opts?: { variant: Record<string, string> }) => {
		await page.evaluate((o) => {
			void window.__journey?.start('responsive', o);
		}, opts);
		await expect(card(page)).toBeVisible();
	};

	test('a phone-sized viewport runs the mobile steps', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mount(page);
		await register(page, [responsive]);
		await startGuide(page);
		await expect(card(page)).toContainText('Phone');
	});

	test('the viewport is read again at each start', async ({ page }) => {
		await mount(page);
		await register(page, [responsive]);
		await startGuide(page);
		await expect(card(page)).toContainText('Desk');
		await page.evaluate(() => window.__journey?.stop());
		await page.setViewportSize({ width: 390, height: 844 });
		await startGuide(page);
		await expect(card(page)).toContainText('Phone');
	});

	test('mount variant overrides detection and start variant overrides mount', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => {
			(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.mount({
				variant: () => ({ viewport: 'tablet' }),
			});
		});
		await waitForApi(page);
		await register(page, [responsive]);
		await startGuide(page);
		await expect(card(page)).toContainText('Pad');
		await page.evaluate(() => window.__journey?.stop());
		await startGuide(page, { variant: { viewport: 'desktop' } });
		await expect(card(page)).toContainText('Desk');
	});
});
