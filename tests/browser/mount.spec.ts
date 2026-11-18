import { expect, type Page, test } from '@playwright/test';
import createNote from '../../demo/journeys/create-note.journey.js';
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

function register(page: Page, journeys: unknown[]) {
	return page.evaluate((list) => window.__journey?.register(list as Journey[]), journeys);
}

async function addStartButton(page: Page, id: string): Promise<void> {
	await page.evaluate((journey) => {
		const button = document.createElement('button');
		button.id = 'tour';
		button.textContent = 'Tour';
		button.setAttribute('data-journey-start', journey);
		document.body.prepend(button);
	}, id);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => localStorage.clear());
});

test('a guide started from data-journey-start asks the user for its fill param', async ({
	page,
}) => {
	await mount(page);
	await register(page, [createNote]);
	await addStartButton(page, 'create-note');
	await page.locator('#tour').click();

	await expect(card(page)).toContainText('Welcome');
	await page.locator('[data-journey="start"]').click();
	await expect(card(page)).toContainText('New note');
	await page.locator('[data-journey="new"]').click();
	await expect(card(page)).toContainText('Title');
	await page.locator('[data-journey="title"]').fill('Typed by the user');
	await expect(card(page)).toContainText('Category');
	await page.locator('[data-journey="category"]').selectOption('idea');
	await expect(card(page)).toContainText('Save');
	await page.locator('[data-journey="save"]').click();

	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
	await expect(page.locator('[data-journey="notes"]')).toContainText('Typed by the user');
	await expect(card(page)).toBeHidden();
});

test('the value a user types is the param for the steps after it', async ({ page }) => {
	await mount(page);
	await register(page, [
		{
			id: 'typed',
			route: '/',
			steps: [
				{ id: 'open', target: 'start', do: { kind: 'click' }, say: { title: 'Open' } },
				{ id: 'type', target: 'notes/search', do: { kind: 'fill', value: { $param: 'var.q' } } },
				{
					id: 'echo',
					guide: 'next',
					say: { title: 'Echo' },
					expect: [{ value: ['notes/search', { $param: 'var.q' }] }],
				},
			],
		},
	]);
	const result = page.evaluate(() => window.__journey?.start('typed'));
	await expect(card(page)).toContainText('Open');
	await page.locator('[data-journey="start"]').click();
	await expect(card(page)).toContainText('Step 2 of 3');
	await page.locator('[data-journey="search"]').fill('milk');
	await expect(card(page)).toContainText('Echo');
	await card(page).locator('button.next').click();
	expect(await result).toMatchObject({ ok: true, completed: 3 });
});

const NEEDS_FIXTURE: Journey = {
	id: 'needs-fixture',
	route: '/',
	steps: [
		{
			id: 'hello',
			target: 'start',
			params: { who: { $param: 'fixture.who' } },
			say: { title: 'Hello', body: 'Welcome.' },
		},
	],
};

test('mount params feed every in-app start', async ({ page }) => {
	await page.evaluate(() => {
		(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.mount({
			params: (id) => (id === 'needs-fixture' ? { 'fixture.who': 'ada' } : undefined),
		});
	});
	await waitForApi(page);
	await register(page, [NEEDS_FIXTURE]);
	await addStartButton(page, 'needs-fixture');
	await page.locator('#tour').click();
	await expect(card(page)).toContainText('Hello');
});

test('a run missing a param it cannot ask for fails before drawing anything', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	await mount(page);
	await register(page, [NEEDS_FIXTURE]);
	const result = await page.evaluate(() => window.__journey?.start('needs-fixture'));
	expect(result).toEqual({
		ok: false,
		completed: 0,
		failures: [
			{
				stepId: 'hello',
				error:
					'missing param "fixture.who": pass it in start("needs-fixture", { params }) or mount({ params })',
			},
		],
	});
	await expect(card(page)).toBeHidden();
	expect(errors.join('\n')).toContain('missing param "fixture.who"');
});

const ONCE: Journey = {
	id: 'once',
	version: 1,
	route: '/',
	autostart: { route: '/', once: true },
	steps: [
		{ id: 'one', say: { title: 'One', body: 'First.' } },
		{ id: 'two', target: { role: 'link' }, say: { title: 'Two', body: 'Ambiguous.' } },
	],
};

const seenMarker = (page: Page) => page.evaluate(() => localStorage.getItem('journey:done:once@1'));

test('exiting an autostart.once guide marks it seen', async ({ page }) => {
	await mount(page);
	await register(page, [ONCE]);
	await expect(card(page)).toContainText('One');
	await card(page).locator('button.exit').click();
	await expect(card(page)).toBeHidden();
	await expect.poll(() => seenMarker(page)).toBe('1');

	await page.reload();
	await mount(page);
	await register(page, [ONCE]);
	await page.waitForTimeout(300);
	await expect(card(page)).toBeHidden();
});

test('a failed autostart.once guide is not marked seen', async ({ page }) => {
	await mount(page);
	await register(page, [ONCE]);
	await expect(card(page)).toContainText('One');
	await card(page).locator('button.next').click();
	await expect(card(page)).toBeHidden();
	await page.waitForTimeout(200);
	expect(await seenMarker(page)).toBeNull();
});

test('an invalid journey is skipped and the rest are registered', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	await mount(page);
	const result = await register(page, [{ id: 'broken', route: '/', steps: 'nope' }, ONCE]);
	expect(result?.registered).toEqual(['once']);
	expect(result?.rejected).toHaveLength(1);
	expect(result?.rejected[0]).toMatchObject({ index: 0, id: 'broken' });
	expect(errors.join('\n')).toContain('journey: skipped broken');
	expect(await page.evaluate(() => window.__journey?.list().map((j) => j.id))).toEqual(['once']);
	await expect(card(page)).toContainText('One');
});

test('an invalid replacement drops the journey registered under its id', async ({ page }) => {
	await mount(page);
	await register(page, [NEEDS_FIXTURE]);
	await register(page, [{ ...NEEDS_FIXTURE, steps: 'nope' }]);
	expect(await page.evaluate(() => window.__journey?.list())).toEqual([]);
	const error = await page.evaluate(() =>
		window.__journey?.start('needs-fixture').catch((e: Error) => e.message),
	);
	expect(error).toBe('journey "needs-fixture" is not registered');
});

test('mount with an invalid journey in its list still installs a working runtime', async ({
	page,
}) => {
	await page.evaluate(
		(list) => {
			(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.mount({
				journeys: list as Journey[],
			});
		},
		[{ id: 'broken' }, ONCE],
	);
	await expect(card(page)).toContainText('One');
});

test('unmount removes the overlay, the listeners and the api', async ({ page }) => {
	await mount(page, { launcher: true });
	await register(page, [NEEDS_FIXTURE, ONCE]);
	await expect(card(page)).toContainText('One');
	await expect(page.locator('journey-overlay')).toHaveCount(1);

	await page.evaluate(() => window.__journey?.unmount());

	await expect(page.locator('journey-overlay')).toHaveCount(0);
	expect(await page.evaluate(() => typeof window.__journey)).toBe('undefined');
	expect(await page.evaluate(() => HTMLDialogElement.prototype.showModal.toString())).toContain(
		'[native code]',
	);
	expect(await seenMarker(page)).toBeNull();

	await addStartButton(page, 'once');
	await page.locator('#tour').click();
	await page.waitForTimeout(200);
	await expect(page.locator('journey-overlay')).toHaveCount(0);

	await mount(page);
	await register(page, [ONCE]);
	await expect(card(page)).toContainText('One');
});

test('a second mount applies its options to the mounted runtime', async ({ page }) => {
	await mount(page);
	const first = await page.evaluate(() => window.__journey?.version);
	await register(page, [NEEDS_FIXTURE]);
	await expect(page.locator('journey-overlay .launcher')).toBeHidden();

	await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const again = runtime.mount({ launcher: true, params: { 'fixture.who': 'ada' } });
		(window as unknown as { __same: boolean }).__same = again === window.__journey;
	});
	expect(await page.evaluate(() => (window as unknown as { __same: boolean }).__same)).toBe(true);
	expect(await page.evaluate(() => window.__journey?.version)).toBe(first);

	const launcher = page.locator('journey-overlay .launcher');
	await expect(launcher).toBeVisible();
	await launcher.getByRole('button', { name: 'Journeys' }).click();
	await launcher.getByRole('button', { name: 'needs-fixture' }).click();
	await expect(card(page)).toContainText('Hello');
});
