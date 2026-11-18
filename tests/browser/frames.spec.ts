import { fileURLToPath } from 'node:url';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import { type CaptureContext, runJourney } from '../../src/playwright/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, ir, RUNTIME_INIT } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

const TOP = `<!doctype html>
<html><body style="margin:0">
<div style="height:120px"></div>
<div style="padding-left:200px">
	<iframe data-journey="outer" src="/__frames-outer.html"
		style="width:640px;height:420px;border:5px solid #000;padding:7px"></iframe>
</div>
<x-host data-journey="host"></x-host>
<script>
	customElements.define('x-host', class extends HTMLElement {
		constructor() {
			super();
			this.attachShadow({ mode: 'open' }).innerHTML = '<div><button data-journey="inner">Inner</button></div>';
		}
	});
</script>
</body></html>`;

const OUTER = `<!doctype html>
<html><body style="margin:0">
<div style="height:30px"></div>
<button data-journey="pay" style="margin-left:25px">Pay</button>
<input data-journey="name">
<input type="checkbox" data-journey="agree">
<p data-journey="status"></p>
<iframe data-journey="inner" src="/__frames-inner.html"
	style="margin-left:50px;width:320px;height:140px;border:3px solid #000"></iframe>
<script>
	const log = (window.log = []);
	const $ = (name) => document.querySelector('[data-journey="' + name + '"]');
	$('pay').addEventListener('click', (event) => {
		const local = event instanceof MouseEvent && event.view === window;
		log.push({ x: event.clientX, y: event.clientY, local });
		$('status').textContent = 'paid';
	});
	$('name').addEventListener('input', (event) => {
		if (event instanceof InputEvent) $('status').textContent = 'typed ' + event.target.value;
	});
</script>
</body></html>`;

const INNER = `<!doctype html>
<html><body style="margin:0">
<div style="height:20px"></div>
<button data-journey="deep" style="margin-left:40px">Deep</button>
</body></html>`;

const PAGES: Record<string, string> = {
	'/__frames.html': TOP,
	'/__frames-outer.html': OUTER,
	'/__frames-inner.html': INNER,
};

test.beforeEach(async ({ context }) => {
	await context.route(
		(url) => url.pathname in PAGES,
		(route) =>
			route.fulfill({
				contentType: 'text/html',
				body: PAGES[new URL(route.request().url()).pathname],
			}),
	);
	await context.route(`${BASE}/dist/**`, (route) =>
		route.fulfill({ path: DIST + new URL(route.request().url()).pathname.slice('/dist/'.length) }),
	);
});

function outer(page: Page): FrameLocator {
	return page.frameLocator('[data-journey="outer"]');
}

function deep(page: Page) {
	return outer(page).frameLocator('[data-journey="inner"]').locator('[data-journey="deep"]');
}

async function open(page: Page): Promise<void> {
	await page.context().addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/__frames.html`);
	await expect(deep(page)).toBeVisible();
	await page.evaluate(() => {
		(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.mount({});
	});
}

async function box(locator: ReturnType<Page['locator']>) {
	const b = await locator.boundingBox();
	if (!b) throw new Error('no box');
	return b;
}

test('the overlay spot, badge and card land on a target inside nested iframes', async ({
	page,
}) => {
	await open(page);
	const drawn = await page.evaluate(() => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const found = runtime.resolveOne('outer>>inner>>deep');
		if (!found.el) throw new Error(found.error);
		for (const part of ['spot', 'badge', 'card'] as const) api.overlay.parts[part].hidden = false;
		api.overlay.track(found.el, { scroll: false });
		const rect = (name: 'spot' | 'badge' | 'card') => {
			const r = api.overlay.parts[name].getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		};
		const t = api.overlay.target();
		return {
			spot: rect('spot'),
			badge: rect('badge'),
			card: rect('card'),
			target: t && { x: t.x, y: t.y, width: t.width, height: t.height },
		};
	});
	const b = await box(deep(page));
	expect(b.x).toBeGreaterThan(300);
	expect(b.y).toBeGreaterThan(150);
	expect(drawn.target).toEqual(b);
	expect(drawn.spot.x).toBeCloseTo(b.x - 6, 0);
	expect(drawn.spot.y).toBeCloseTo(b.y - 6, 0);
	expect(drawn.spot.width).toBeCloseTo(b.width + 12, 0);
	expect(drawn.badge.x).toBeCloseTo(b.x - 6 - 13, 0);
	expect(drawn.card.y).toBeCloseTo(b.y + b.height + 18, 0);
	expect(drawn.card.x).toBeCloseTo(b.x, 0);
});

test('the guide cursor and ripple point at a target inside an iframe', async ({ page }) => {
	await open(page);
	const at = await page.evaluate(async () => {
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const api = window.__journey as NonNullable<typeof window.__journey>;
		const el = runtime.resolveOne('outer>>inner>>deep').el as Element;
		const presenter = runtime.docPresenter(api.overlay);
		await presenter.moveCursor?.(el);
		presenter.ripple?.(el);
		const ripple = api.overlay.parts.ripple.style;
		return {
			cursor: api.overlay.parts.cursor.style.transform,
			ripple: { x: Number.parseFloat(ripple.left), y: Number.parseFloat(ripple.top) },
		};
	});
	const b = await box(deep(page));
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	expect(at.ripple.x).toBeCloseTo(cx, 0);
	expect(at.ripple.y).toBeCloseTo(cy, 0);
	const [x, y] = (at.cursor.match(/-?[\d.]+/g) ?? []).map(Number);
	expect(x).toBeCloseTo(cx - 4, 1);
	expect(y).toBeCloseTo(cy - 2, 1);
});

test('the dom actor clicks, fills and checks inside an iframe like a user would', async ({
	page,
}) => {
	await open(page);
	const journey = ir({
		id: 'frames',
		route: '/__frames.html',
		steps: [
			{ id: 'pay', target: 'outer>>pay', do: { kind: 'click' } },
			{ id: 'name', target: 'outer>>name', do: { kind: 'fill', value: 'Ada' } },
			{ id: 'agree', target: 'outer>>agree', do: { kind: 'check', checked: true } },
		],
	});
	const result = (await page.evaluate(async (j) => {
		await window.__journey?.register([j]);
		return window.__journey?.start('frames', { mode: 'run' });
	}, journey)) as RunResult;
	expect(result).toMatchObject({ ok: true, completed: 3 });
	const pay = await outer(page)
		.locator('[data-journey="pay"]')
		.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		});
	const log = await outer(page)
		.locator('body')
		.evaluate(
			() => (window as unknown as { log: Array<{ x: number; y: number; local: boolean }> }).log,
		);
	expect(log).toHaveLength(1);
	expect(log[0]?.local).toBe(true);
	expect(Math.abs((log[0]?.x ?? 0) - pay.x)).toBeLessThanOrEqual(1);
	expect(Math.abs((log[0]?.y ?? 0) - pay.y)).toBeLessThanOrEqual(1);
	await expect(outer(page).locator('[data-journey="name"]')).toHaveValue('Ada');
	await expect(outer(page).locator('[data-journey="status"]')).toHaveText('typed Ada');
	await expect(outer(page).locator('[data-journey="agree"]')).toBeChecked();
});

test('runJourney acts on iframe targets and crops captures in page coordinates', async ({
	page,
}) => {
	const journey: IR = ir({
		id: 'frames',
		route: '/__frames.html',
		steps: [
			{ id: 'pay', target: 'outer>>pay', do: { kind: 'click' } },
			{ id: 'name', target: 'outer>>name', do: { kind: 'fill', value: 'Ada' } },
			{ id: 'agree', target: 'outer>>agree', do: { kind: 'check', checked: true } },
			{
				id: 'deep',
				target: 'outer>>inner>>deep',
				do: { kind: 'click' },
				capture: { name: 'deep', crop: 'target' },
			},
		],
	});
	const captures: CaptureContext[] = [];
	const result = await runJourney(page, journey, {
		baseUrl: BASE,
		async onCapture(_spec, ctx) {
			captures.push(ctx);
		},
	});
	expect(result).toEqual({ ok: true, completed: 4, failures: [] });
	await expect(outer(page).locator('[data-journey="status"]')).toHaveText('typed Ada');
	await expect(outer(page).locator('[data-journey="agree"]')).toBeChecked();
	expect(captures.map((c) => c.stepId)).toEqual(['deep']);
	expect(captures[0]?.rect).toEqual(await box(deep(page)));
});

test('the picker picks the element inside a shadow root and inside nested iframes', async ({
	page,
}) => {
	await open(page);
	const pick = () =>
		page.evaluate(async () => {
			const { pickElement } = (await import(
				'/dist/editor/pick.js' as string
			)) as typeof import('../../src/editor/pick.js');
			const api = window.__journey as NonNullable<typeof window.__journey>;
			const w = window as unknown as { picked?: Promise<string | null> };
			w.picked = pickElement(api.overlay).then((el) => el?.textContent?.trim() ?? null);
		});
	const picked = () =>
		page.evaluate(() => (window as unknown as { picked: Promise<string | null> }).picked);

	await pick();
	await page.locator('x-host [data-journey="inner"]').hover();
	const spot = await page.evaluate(() => {
		const r = window.__journey?.overlay.target();
		return r ? { x: r.x, y: r.y } : null;
	});
	const inner = await box(page.locator('x-host [data-journey="inner"]'));
	expect(spot).toEqual({ x: inner.x, y: inner.y });
	await page.locator('x-host [data-journey="inner"]').click();
	expect(await picked()).toBe('Inner');

	await pick();
	await deep(page).hover();
	const b = await box(deep(page));
	expect(
		await page.evaluate(() => {
			const r = window.__journey?.overlay.target();
			return r ? { x: r.x, y: r.y } : null;
		}),
	).toEqual({ x: b.x, y: b.y });
	await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
	expect(await picked()).toBe('Deep');

	await pick();
	await outer(page).locator('[data-journey="pay"]').click();
	expect(await picked()).toBe('Pay');
	await expect(outer(page).locator('[data-journey="status"]')).toHaveText('');
});
