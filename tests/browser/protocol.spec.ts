import { expect, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import type { LoadOptions, SettleResult, StepResult } from '../../src/runtime/index.js';
import {
	BASE,
	createNoteIR,
	defaultLoad,
	driverActed,
	driverLoad,
	driverSettle,
	driverStep,
	mountRuntime,
	performAction,
	RUNTIME_INIT,
	settingsThemeIR,
} from './helpers.js';

interface Trace {
	steps: StepResult[];
	settles: SettleResult[];
}

async function drive(page: Page, journey: IR, opts: LoadOptions): Promise<Trace> {
	const trace: Trace = { steps: [], settles: [] };
	for (;;) {
		const r = await driverStep(page);
		trace.steps.push(r);
		if (r.done) return trace;
		if ('route' in r) {
			await page.goto(new URL(r.route, BASE).href);
			await mountRuntime(page);
			await driverLoad(page, journey, opts);
			continue;
		}
		const timeout = journey.steps[r.index]?.timeout ?? 10000;
		if (r.action && r.marker) await performAction(page, r.marker, r.action, timeout);
		await driverActed(page);
		trace.settles.push(await driverSettle(page));
	}
}

test.beforeEach(async ({ context }) => {
	await context.addInitScript(RUNTIME_INIT);
});

test('runs create-note through the driver with captures in order', async ({ page }) => {
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	expect(await driverLoad(page, createNoteIR, defaultLoad)).toEqual({ resumedAt: null });
	const trace = await drive(page, createNoteIR, defaultLoad);
	expect(trace.steps.map((s) => (s.done ? 'done' : 'marker' in s ? s.marker : s.route))).toEqual([
		'start',
		'new',
		'title',
		'category',
		'save',
		'done',
	]);
	expect(trace.steps.at(-1)).toEqual({
		done: true,
		result: { ok: true, completed: 5, failures: [] },
	});
	expect(trace.settles.map((s) => [s.stepId, s.ok, s.capture])).toEqual([
		['start', true, { name: 'notes' }],
		['new', true, { name: 'dialog' }],
		['title', true, null],
		['category', true, null],
		['save', true, { name: 'saved', video: true }],
	]);
	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
	await expect(page.locator('[data-journey-focus]')).toHaveCount(0);
});

test('settings-theme survives the full navigation through the back link', async ({ page }) => {
	await page.goto(`${BASE}/settings.html`);
	await mountRuntime(page);
	await driverLoad(page, settingsThemeIR, defaultLoad);

	const theme = await driverStep(page);
	expect(theme).toMatchObject({ done: false, stepId: 'theme', index: 0, marker: 'theme' });
	await page.locator('[data-journey-focus="theme"]').selectOption('dark');
	await driverActed(page);
	expect(await driverSettle(page)).toEqual({
		ok: true,
		capture: { name: 'dark' },
		index: 0,
		stepId: 'theme',
	});
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	const escapeStep = await driverStep(page);
	expect(escapeStep).toMatchObject({
		done: false,
		stepId: 'escape',
		index: 2,
		action: { kind: 'press', key: 'Escape' },
	});
	await page.locator('[data-journey-focus="escape"]').press('Escape');
	await driverActed(page);
	expect(await driverSettle(page)).toMatchObject({ ok: true, capture: null, stepId: 'escape' });

	const back = await driverStep(page);
	expect(back).toMatchObject({
		done: false,
		stepId: 'back',
		index: 3,
		marker: 'back',
		action: { kind: 'click' },
	});
	await page.locator('[data-journey-focus="back"]').click();
	await driverActed(page).catch(() => {});
	await driverSettle(page).catch(() => {});
	await page.waitForURL('**/#notes');
	await expect(page.locator('[data-journey="notes"]')).toBeVisible();

	await mountRuntime(page);
	expect(await driverLoad(page, settingsThemeIR, defaultLoad)).toEqual({ resumedAt: 3 });
	expect(await driverStep(page)).toEqual({
		done: false,
		stepId: 'back',
		index: 3,
		action: null,
		marker: null,
	});
	expect(await driverSettle(page)).toEqual({ ok: true, capture: null, index: 3, stepId: 'back' });
	expect(await driverStep(page)).toEqual({
		done: true,
		result: { ok: true, completed: 1, failures: [] },
	});
	expect(await page.evaluate(() => sessionStorage.getItem('journey:progress'))).toBeNull();
});

test('a wrong expectation fails with the step id', async ({ page }) => {
	const wrong: IR = {
		...createNoteIR,
		steps: createNoteIR.steps.map((s) =>
			s.id === 'new' ? { ...s, expect: [{ visible: 'nope' }], timeout: 300 } : s,
		),
	};
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	await driverLoad(page, wrong, defaultLoad);
	const trace = await drive(page, wrong, defaultLoad);
	expect(trace.settles.at(-1)).toEqual({
		ok: false,
		error: 'visible nope: 0 matches',
		capture: null,
		index: 1,
		stepId: 'new',
	});
	expect(trace.steps.at(-1)).toEqual({
		done: true,
		result: {
			ok: false,
			completed: 1,
			failures: [{ stepId: 'new', error: 'visible nope: 0 matches' }],
		},
	});
});

test('protocol misuse rejects with readable errors', async ({ page }) => {
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	await expect(driverStep(page)).rejects.toThrow('call load() before step()');
	await driverLoad(page, createNoteIR, defaultLoad);
	await expect(driverSettle(page)).rejects.toThrow('settle() called without a pending step');
	await expect(driverActed(page)).rejects.toThrow('without a pending action');
	await driverStep(page);
	await expect(driverStep(page)).rejects.toThrow('call acted() and settle()');
	await expect(driverSettle(page)).rejects.toThrow('call acted() before settle()');
});
