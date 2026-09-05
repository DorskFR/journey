import { expect, type Page, test } from '@playwright/test';
import type { ExportDetail } from '../../src/editor/export.js';
import type { Draft } from '../../src/editor/index.js';
import type { IR } from '../../src/index.js';
import type { LoadOptions } from '../../src/runtime/index.js';
import {
	BASE,
	defaultLoad,
	driverActed,
	driverLoad,
	driverSettle,
	driverStep,
	mountRuntime,
	performAction,
	RUNTIME_INIT,
} from './helpers.js';

declare global {
	interface Window {
		__exported?: ExportDetail;
	}
}

const panel = (page: Page, name: string) => page.locator(`journey-overlay [data-editor="${name}"]`);
const row = (page: Page, index: number) =>
	page.locator(`journey-overlay [data-editor="step"][data-index="${index}"]`);

function draft(page: Page): Promise<Draft> {
	return page.evaluate(() => JSON.parse(JSON.stringify(window.__journeyEditor?.draft())) as Draft);
}

async function waitForEditor(page: Page): Promise<void> {
	await page.waitForFunction(() => typeof window.__journeyEditor !== 'undefined');
	await page.evaluate(() => window.__journeyEditor?.reset());
}

async function recordCreateNote(page: Page): Promise<void> {
	await page.goto(`${BASE}/?journey=edit`);
	await waitForEditor(page);
	await panel(page, 'record').click();
	await expect(panel(page, 'stop')).toBeVisible();
	await page.click('[data-journey="start"]');
	await page.click('[data-journey="new"]');
	await page.fill('[data-journey="dialog"] [data-journey="title"]', 'Buy milk');
	await page.selectOption('[data-journey="dialog"] [data-journey="category"]', 'idea');
	await page.click('[data-journey="dialog"] [data-journey="save"]');
	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
	await panel(page, 'stop').click();
	await expect(panel(page, 'record')).toBeVisible();
}

async function waitForSuggestions(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const steps = window.__journeyEditor?.draft().steps ?? [];
		return [1, 4].every((i) => (steps[i]?.suggestions.length ?? 0) > 0);
	});
}

async function drive(page: Page, journey: IR, opts: LoadOptions): Promise<boolean> {
	for (;;) {
		const r = await driverStep(page);
		if (r.done) return r.result.ok;
		if ('route' in r) {
			await page.goto(new URL(r.route, BASE).href);
			await mountRuntime(page);
			await driverLoad(page, journey, opts);
			continue;
		}
		const timeout = journey.steps[r.index]?.timeout ?? 10000;
		if (r.action && r.marker) await performAction(page, r.marker, r.action, timeout);
		await driverActed(page);
		const settle = await driverSettle(page);
		if (!settle.ok) throw new Error(`${settle.stepId}: ${settle.error}`);
	}
}

test('records the create-note flow with stable targets and suggestions', async ({ page }) => {
	await recordCreateNote(page);
	await waitForSuggestions(page);
	const d = await draft(page);
	expect(d.steps.map((s) => s.target)).toEqual([
		'start',
		'notes/new',
		'dialog/title',
		'dialog/category',
		'dialog/save',
	]);
	expect(d.steps.map((s) => s.do?.kind)).toEqual(['click', 'click', 'fill', 'select', 'click']);
	expect(d.steps.map((s) => s.health)).toEqual(Array(5).fill('stable'));
	expect(d.steps[0]?.route).toBe('/');
	expect(d.steps[1]?.route).toBe('/#notes');
	expect(d.steps[2]?.do).toEqual({ kind: 'fill', value: 'Buy milk' });
	expect(d.steps[3]?.do).toEqual({ kind: 'select', value: 'idea' });
	expect(d.steps[0]?.suggestions.map((s) => s.expectation)).toContainEqual({ url: '/#notes' });
	expect(d.steps[1]?.suggestions.map((s) => s.expectation)).toContainEqual({ visible: 'dialog' });
	expect(d.steps[2]?.suggestions).toEqual([]);
	expect(d.steps[4]?.suggestions.map((s) => s.expectation)).toContainEqual({
		count: ['notes/note', { equals: 4 }],
	});
	expect(await page.locator('journey-overlay [data-editor="step"]').count()).toBe(5);
	await expect(row(page, 0).locator('[data-editor="health"]')).toHaveAttribute(
		'data-health',
		'stable',
	);

	await row(page, 1).locator('[data-editor="suggestion"]').first().check();
	await row(page, 4).locator('[data-editor="suggestion"]').first().check();
	const accepted = await draft(page);
	expect(
		accepted.steps[1]?.suggestions.filter((s) => s.accepted).map((s) => s.expectation),
	).toEqual([{ visible: 'dialog' }]);
	expect(
		accepted.steps[4]?.suggestions.filter((s) => s.accepted).map((s) => s.expectation),
	).toEqual([{ count: ['notes/note', { equals: 4 }] }]);
	await expect(row(page, 1).locator('[data-editor="remove-expect"]')).toHaveCount(1);

	await page.reload();
	await page.waitForFunction(() => typeof window.__journeyEditor !== 'undefined');
	expect((await draft(page)).steps.map((s) => s.id)).toEqual(accepted.steps.map((s) => s.id));
});

test('exports source that compiles and passes through the driver', async ({ page, context }) => {
	await recordCreateNote(page);
	await waitForSuggestions(page);
	await row(page, 1).locator('[data-editor="suggestion"]').first().check();
	await row(page, 4).locator('[data-editor="suggestion"]').first().check();
	await panel(page, 'id').fill('recorded-note');
	await page.evaluate(() => {
		window.addEventListener('journey:export', (event) => {
			window.__exported = (event as CustomEvent<ExportDetail>).detail;
		});
	});
	await panel(page, 'export').click();
	await page.waitForFunction(() => window.__exported !== undefined);
	const detail = await page.evaluate(() => window.__exported as ExportDetail);
	expect(detail.id).toBe('recorded-note');
	expect(detail.source.startsWith('import { defineJourney')).toBe(true);
	expect(detail.source).toContain("target: 'dialog/title'");
	expect(detail.ir.steps.map((s) => s.id)).toEqual(['start', 'new', 'title', 'category', 'save']);
	expect(detail.ir.steps[1]?.expect).toEqual([{ visible: 'dialog' }]);

	await context.addInitScript(RUNTIME_INIT);
	const fresh = await context.newPage();
	await fresh.goto(`${BASE}/`);
	await mountRuntime(fresh);
	await driverLoad(fresh, detail.ir, defaultLoad);
	expect(await drive(fresh, detail.ir, defaultLoad)).toBe(true);
	await expect(fresh.locator('[data-journey="note"]')).toHaveCount(4);
});

test('records a Like click as fragile with a css locator', async ({ page }) => {
	await page.goto(`${BASE}/?journey=edit`);
	await waitForEditor(page);
	await panel(page, 'record').click();
	await page.locator('[data-journey="likes"] button').nth(2).click();
	await panel(page, 'stop').click();
	const d = await draft(page);
	expect(d.steps).toHaveLength(1);
	expect(d.steps[0]?.health).toBe('fragile');
	expect(d.steps[0]?.target).toHaveProperty('css');
	await expect(row(page, 0).locator('[data-editor="health"]')).toHaveAttribute(
		'data-health',
		'fragile',
	);
	const target = d.steps[0]?.target as Record<string, string>;
	const resolved = await page.evaluate((t) => {
		const r = (
			window as unknown as { journeyRuntime: typeof import('../../src/runtime/index.js') }
		).journeyRuntime.resolveOne(t);
		return r.el ? r.el.textContent : null;
	}, target);
	expect(resolved).toBe('Like');
});

test('records a password fill as a masked param', async ({ page }) => {
	await page.goto(`${BASE}/settings.html?journey=edit`);
	await waitForEditor(page);
	await panel(page, 'record').click();
	await page.fill('[data-journey="token"]', 'hunter2');
	await panel(page, 'stop').click();
	const d = await draft(page);
	expect(d.steps).toHaveLength(1);
	expect(d.steps[0]?.target).toBe('token');
	expect(d.steps[0]?.do).toEqual({ kind: 'fill', value: { $param: 'var.token' }, mask: true });
	expect(JSON.stringify(d)).not.toContain('hunter2');
});

test('Run marks rows and Preview shows the guide card', async ({ page }) => {
	await recordCreateNote(page);
	await page.goto(`${BASE}/?journey=edit`);
	await page.waitForFunction(() => typeof window.__journeyEditor !== 'undefined');
	await expect(panel(page, 'step')).toHaveCount(5);
	await panel(page, 'run').click();
	for (let i = 0; i < 5; i++) {
		await expect(row(page, i)).toHaveAttribute('data-result', 'pass');
	}
	await expect(panel(page, 'run')).toBeEnabled();
	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);

	await page.goto(`${BASE}/?journey=edit`);
	await page.waitForFunction(() => typeof window.__journeyEditor !== 'undefined');
	await panel(page, 'preview').click();
	await expect(page.locator('journey-overlay .card')).toContainText('Step 1 of 5');
});

async function seedDraft(page: Page, draft: Draft): Promise<void> {
	await page.goto(`${BASE}/?journey=edit`);
	await page.evaluate((d) => {
		sessionStorage.setItem(
			'journey:draft',
			JSON.stringify({ draft: d, recording: false, lastRoute: '', results: {} }),
		);
	}, draft);
	await page.reload();
	await page.waitForFunction(() => typeof window.__journeyEditor !== 'undefined');
}

test('a run resumes after a full navigation', async ({ page }) => {
	await seedDraft(page, {
		id: 'settings-run',
		title: '',
		route: '/settings.html',
		steps: [
			{
				id: 'theme',
				route: '/settings.html',
				target: 'theme',
				do: { kind: 'select', value: 'dark' },
				health: 'stable',
				suggestions: [],
			},
			{
				id: 'token',
				target: 'token',
				do: { kind: 'fill', value: 'secret' },
				health: 'stable',
				suggestions: [],
			},
		],
	});
	await page.locator('[data-editor="run"]').click();
	await page.waitForURL(/\/settings\.html\?journey=edit$/);
	await expect(page.locator('[data-journey="token"]')).toHaveValue('secret');
	await expect(page.locator('[data-editor="step"][data-result="pass"]')).toHaveCount(2);
	expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('values fill masked params and are missing when cleared', async ({ page }) => {
	await page.goto(`${BASE}/settings.html?journey=edit`);
	await waitForEditor(page);
	await panel(page, 'record').click();
	await page.fill('[data-journey="token"]', 'hunter2');
	await panel(page, 'stop').click();
	await expect(panel(page, 'record')).toBeVisible();
	await page.fill('[data-journey="token"]', '');
	const value = page.locator('journey-overlay [data-editor="var"][data-name="token"]');
	await expect(value).toHaveAttribute('type', 'password');
	await value.fill('hunter2');
	await panel(page, 'run').click();
	await expect(row(page, 0)).toHaveAttribute('data-result', 'pass');
	await expect(page.locator('[data-journey="token"]')).toHaveValue('hunter2');
	await expect(panel(page, 'toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(panel(page, 'toggle')).toContainText('pass 1/1');
	expect(await page.evaluate(() => sessionStorage.getItem('journey:vars'))).toBe(
		JSON.stringify({ token: 'hunter2' }),
	);
	expect(await page.evaluate(() => sessionStorage.getItem('journey:draft'))).not.toContain(
		'hunter2',
	);

	await panel(page, 'toggle').click();
	await expect(panel(page, 'toggle')).toHaveAttribute('aria-expanded', 'true');
	await value.fill('');
	await panel(page, 'run').click();
	await expect(row(page, 0)).toHaveAttribute('data-result', 'fail');
	await expect(row(page, 0).locator('[data-editor="error"]')).toContainText('var.token');
	await expect(panel(page, 'toggle')).toContainText('fail 0/1');
});

test('the picker adds an expectation from a clicked element', async ({ page }) => {
	await recordCreateNote(page);
	await row(page, 4).locator('[data-editor="add-expect"]').click();
	const form = row(page, 4).locator('[data-editor="expect-form"]');
	await expect(form).toBeVisible();
	await form.locator('[data-editor="expect-kind"]').selectOption('visible');
	await page.evaluate(() => {
		void window.__journeyEditor?.pick();
	});
	await expect(page.locator('journey-overlay .spot')).toHaveClass(/doc/);
	await page.click('[data-journey="notes"] h1');
	await expect(form.locator('[data-editor="expect-target"]')).toHaveText('notes');
	await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
	await form.locator('[data-editor="expect-add"]').click();
	await expect(form).toHaveCount(0);
	await expect(row(page, 4).locator('[data-editor="remove-expect"]:not([hidden])')).toHaveCount(1);
	await page.evaluate(() => {
		window.addEventListener('journey:export', (event) => {
			window.__exported = (event as CustomEvent<ExportDetail>).detail;
		});
	});
	await panel(page, 'export').click();
	await page.waitForFunction(() => window.__exported !== undefined);
	const detail = await page.evaluate(() => window.__exported as ExportDetail);
	expect(detail.ir.steps[4]?.expect).toEqual([{ visible: 'notes' }]);
	expect(detail.source).toContain("visible: 'notes'");
});

test('Preview steps through with Next', async ({ page }) => {
	await seedDraft(page, {
		id: 'stepped',
		title: '',
		route: '/',
		steps: [
			{
				id: 'start',
				route: '/',
				target: 'start',
				do: { kind: 'click' },
				health: 'stable',
				suggestions: [],
			},
			{ id: 'new', target: 'notes/new', do: { kind: 'click' }, health: 'stable', suggestions: [] },
		],
	});
	await panel(page, 'preview').click();
	await expect(panel(page, 'toggle')).toHaveAttribute('aria-expanded', 'false');
	await expect(panel(page, 'toggle')).toContainText('running 0/2');
	const card = page.locator('journey-overlay .card');
	await expect(card).toContainText('Step 1 of 2');
	await expect(card.locator('button.next')).toBeVisible();
	await expect(card).toContainText('Step 1 of 2');
	await page.keyboard.press('Enter');
	await expect(card).toContainText('Step 2 of 2');
	await expect(row(page, 0)).toHaveAttribute('data-result', 'pass');
	await expect(panel(page, 'toggle')).toContainText('running 1/2');
});
