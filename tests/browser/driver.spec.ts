import { expect, test } from '@playwright/test';
import type { Capture, IR } from '../../src/index.js';
import { type CaptureContext, captureStep, runJourney } from '../../src/playwright/index.js';
import { BASE, createNoteIR, settingsThemeIR } from './helpers.js';

const params = { 'var.title': 'Buy milk' };

for (const viewport of ['desktop', 'mobile']) {
	test(`runJourney runs create-note on ${viewport} with trusted input`, async ({ page }) => {
		const captures: Array<[string, CaptureContext]> = [];
		const result = await runJourney(page, createNoteIR, {
			baseUrl: BASE,
			params,
			variant: { viewport },
			async onCapture(spec, ctx) {
				captures.push([spec.name, ctx]);
			},
		});
		expect(result).toEqual({ ok: true, completed: 5, failures: [] });
		expect(page.viewportSize()).toEqual(
			viewport === 'desktop' ? { width: 1280, height: 800 } : { width: 390, height: 844 },
		);
		expect(captures.map(([name, ctx]) => [name, ctx.stepId, ctx.index, ctx.title])).toEqual([
			['notes', 'start', 0, 'Welcome'],
			['dialog', 'new', 1, 'New note'],
			['saved', 'save', 4, 'Save'],
		]);
		expect(captures[0]?.[1].body).toBe('Click Get started to open your notes.');
		await expect(page.locator('[data-journey="note"]')).toHaveCount(4);
		await expect(page.locator('[data-journey="note"]').last()).toContainText('Buy milk');
	});
}

test('settings-theme survives the full navigation through the back link', async ({ page }) => {
	const captured: string[] = [];
	const result = await runJourney(page, settingsThemeIR, {
		baseUrl: BASE,
		params,
		variant: { viewport: 'desktop', theme: 'light' },
		async onCapture(spec) {
			captured.push(spec.name);
		},
	});
	expect(result).toEqual({ ok: true, completed: 3, failures: [] });
	expect(captured).toEqual(['dark']);
	expect(new URL(page.url()).hash).toBe('#notes');
	await expect(page.locator('[data-journey="notes"]')).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('journey:progress'))).toBeNull();
});

test('a wrong expectation fails with the step id', async ({ page }) => {
	const wrong: IR = {
		...createNoteIR,
		steps: createNoteIR.steps.map((s) =>
			s.id === 'new' ? { ...s, expect: [{ visible: 'nope' }], timeout: 300 } : s,
		),
	};
	const result = await runJourney(page, wrong, { baseUrl: BASE, params });
	expect(result).toEqual({
		ok: false,
		completed: 1,
		failures: [{ stepId: 'new', error: 'visible nope: 0 matches' }],
	});
});

test('book mode applies masks and crops captures to the target', async ({ page }) => {
	const filters: string[] = [];
	const sizes: Array<[Capture, number]> = [];
	const masked: IR = {
		...createNoteIR,
		steps: createNoteIR.steps.map((s) =>
			s.id === 'new' ? { ...s, capture: { name: 'dialog', crop: 'target' } } : s,
		),
	};
	const result = await runJourney(page, masked, {
		baseUrl: BASE,
		params,
		mask: true,
		presenter: 'doc',
		async onCapture(spec, ctx) {
			filters.push(
				await page.evaluate(() => {
					const el = document.querySelector('[data-journey-mask]');
					return el ? getComputedStyle(el).filter : 'missing';
				}),
			);
			const png = await captureStep(page, spec, ctx);
			sizes.push([spec, png.length]);
			if (spec.crop === 'target') {
				expect(ctx.rect).not.toBeNull();
				const view = page.viewportSize() as { width: number; height: number };
				expect((ctx.rect as { width: number }).width).toBeLessThan(view.width);
			}
		},
	});
	expect(result.ok, JSON.stringify(result.failures)).toBe(true);
	expect(filters).toHaveLength(3);
	for (const filter of filters) expect(filter).toContain('blur');
	const full = sizes.find(([spec]) => spec.name === 'notes')?.[1] ?? 0;
	const cropped = sizes.find(([spec]) => spec.name === 'dialog')?.[1] ?? 0;
	expect(cropped).toBeGreaterThan(0);
	expect(cropped).toBeLessThan(full);
});

test('a step holds for its own pace', async ({ page }) => {
	const paced: IR = {
		...createNoteIR,
		steps: createNoteIR.steps.map((s) =>
			s.id === 'new' ? { ...s, pace: { beforeAction: 400, afterSettle: 400 } } : s,
		),
	};
	const start = Date.now();
	const result = await runJourney(page, paced, { baseUrl: BASE, params });
	const elapsed = Date.now() - start;
	expect(result.ok).toBe(true);
	expect(elapsed).toBeGreaterThanOrEqual(800);
});

const LATE_HOVER = `<!doctype html><html><body>
<button data-journey="trigger" style="margin:80px">Trigger</button>
<span data-journey="bubble" hidden>Tooltip</span>
<script>
setTimeout(() => {
	const b = document.querySelector('[data-journey="bubble"]');
	document.querySelector('[data-journey="trigger"]')
		.addEventListener('pointerover', () => { b.hidden = false; });
}, 4000);
</script>
</body></html>`;

test('a hover that lands before the page listens is delivered again', async ({ page }) => {
	await page.route('**/late-hover.html*', (route) =>
		route.fulfill({ contentType: 'text/html', body: LATE_HOVER }),
	);
	const late: IR = {
		id: 'late-hover',
		version: 1,
		route: '/late-hover.html',
		level: 'smoke',
		steps: [
			{
				id: 'tip',
				target: 'trigger',
				do: { kind: 'hover' },
				guide: 'wait-for-user',
				timeout: 9000,
				expect: [{ visible: 'bubble' }],
			},
		],
	};
	const result = await runJourney(page, late, { baseUrl: BASE });
	expect(result, JSON.stringify(result.failures)).toEqual({ ok: true, completed: 1, failures: [] });
});
