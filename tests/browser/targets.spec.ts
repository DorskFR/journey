import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { Target } from '../../src/index.js';
import { BASE, RUNTIME_INIT } from './helpers.js';

type Runtime = typeof import('../../src/runtime/index.js');

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const FIXTURE = `${BASE}/__targets.html`;

const FRAME = `
<section data-journey="pay">
	<button data-journey="submit">Pay</button>
	<button>Cancel</button>
</section>`;

const HTML = `<!doctype html>
<html><body>
<main data-journey="app">
	<x-card data-journey="card"></x-card>
	<x-sealed data-journey="sealed"></x-sealed>
	<button data-journey="ok">Light OK</button>
	<iframe data-journey="frame" srcdoc="${FRAME.replace(/"/g, '&quot;')}"></iframe>
</main>
<script>
	customElements.define('x-card', class extends HTMLElement {
		constructor() {
			super();
			this.attachShadow({ mode: 'open' }).innerHTML =
				'<button data-journey="ok">OK</button>' +
				'<button>Plain</button>' +
				'<label><input type="checkbox" name="agree"> Agree</label>' +
				'<div><span tabindex="0" style="display:inline-block;width:20px;height:20px"></span></div>';
		}
	});
	customElements.define('x-sealed', class extends HTMLElement {
		constructor() {
			super();
			this.attachShadow({ mode: 'closed' }).innerHTML = '<button data-journey="ok">Sealed</button>';
		}
	});
</script>
</body></html>`;

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.route(FIXTURE, (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
	await page.route(`${BASE}/dist/**`, (route) =>
		route.fulfill({ path: DIST + new URL(route.request().url()).pathname.slice('/dist/'.length) }),
	);
	await page.goto(FIXTURE);
	await expect(page.frameLocator('[data-journey="frame"]').getByText('Pay')).toBeVisible();
});

function one(page: Page, target: Target) {
	return page.evaluate((t) => {
		const r = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime.resolveOne(t);
		return r.error === undefined ? r.el.textContent?.trim() : r.error;
	}, target);
}

test('a >> segment reaches into an open shadow root', async ({ page }) => {
	expect(await one(page, 'app/card>>ok')).toBe('OK');
	expect(await one(page, 'card >> ok')).toBe('OK');
	expect(await one(page, { role: 'button', name: 'Plain', within: 'card>>' })).toBe('Plain');
});

test('targets without >> resolve exactly as before', async ({ page }) => {
	expect(await one(page, 'ok')).toBe('Light OK');
	expect(await one(page, 'app/card/ok')).toBe('notfound');
	expect(await one(page, { role: 'button', name: 'Plain' })).toBe('notfound');
});

test('closed shadow roots stay out of reach', async ({ page }) => {
	expect(await one(page, 'sealed>>ok')).toBe('notfound');
});

test('a >> segment reaches into a same-origin iframe', async ({ page }) => {
	expect(await one(page, 'app/frame>>pay/submit')).toBe('Pay');
	expect(await one(page, { text: 'Cancel', within: 'frame>>pay' })).toBe('Cancel');
	expect(await one(page, { css: 'button', within: 'frame>>' })).toBe('ambiguous');
});

test('a path ending in >> is only a scope, never a target', async ({ page }) => {
	const message = await page.evaluate(() => {
		try {
			(window as unknown as { journeyRuntime: Runtime }).journeyRuntime.resolveAll('card>>');
			return null;
		} catch (e) {
			return (e as Error).message;
		}
	});
	expect(message).toContain('ends with ">>"');
});

test('locate records shadow and frame elements as targets that resolve back to them', async ({
	page,
}) => {
	const located = await page.evaluate(async () => {
		const { locate } = (await import(
			'/dist/editor/locate.js' as string
		)) as typeof import('../../src/editor/locate.js');
		const runtime = (window as unknown as { journeyRuntime: Runtime }).journeyRuntime;
		const card = document.querySelector('x-card')?.shadowRoot as ShadowRoot;
		const doc = (document.querySelector('iframe') as HTMLIFrameElement).contentDocument as Document;
		const els = {
			shadowPath: card.querySelector('[data-journey="ok"]'),
			shadowLocator: card.querySelectorAll('button')[1],
			shadowFragile: card.querySelector('span'),
			framePath: doc.querySelector('[data-journey="submit"]'),
			frameLocator: doc.querySelectorAll('button')[1],
		};
		return Object.fromEntries(
			Object.entries(els).map(([name, el]) => {
				const { target, health } = locate(el as Element);
				return [name, { target, health, back: runtime.resolveOne(target).el === el }];
			}),
		);
	});
	expect(located).toEqual({
		shadowPath: { target: 'app/card>>ok', health: 'stable', back: true },
		shadowLocator: {
			target: { role: 'button', name: 'Plain', within: 'app/card>>' },
			health: 'fallback',
			back: true,
		},
		shadowFragile: {
			target: { css: 'div:nth-of-type(1) > span:nth-of-type(1)', within: 'app/card>>' },
			health: 'fragile',
			back: true,
		},
		framePath: { target: 'app/frame>>pay/submit', health: 'stable', back: true },
		frameLocator: {
			target: { role: 'button', name: 'Cancel', within: 'app/frame>>pay' },
			health: 'fallback',
			back: true,
		},
	});
});

test('the recorder sees clicks and checks inside shadow roots and iframes', async ({ page }) => {
	await page.evaluate(async () => {
		const { createObserver } = (await import(
			'/dist/editor/observe.js' as string
		)) as typeof import('../../src/editor/observe.js');
		const { locate } = (await import(
			'/dist/editor/locate.js' as string
		)) as typeof import('../../src/editor/locate.js');
		const w = window as unknown as { recorded: unknown[] };
		w.recorded = [];
		createObserver({
			ignore: () => false,
			prepare: (el) => locate(el).target,
			emit: (item) => w.recorded.push({ target: item.prepared, do: item.do }),
		}).start();
	});
	await page.locator('x-card [data-journey="ok"]').click();
	await page.locator('x-card input[name="agree"]').check();
	await page.frameLocator('[data-journey="frame"]').getByText('Pay').click();
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { recorded: unknown[] }).recorded))
		.toEqual([
			{ target: 'app/card>>ok', do: { kind: 'click' } },
			{
				target: { label: 'Agree', within: 'app/card>>' },
				do: { kind: 'check', checked: true },
			},
			{ target: 'app/frame>>pay/submit', do: { kind: 'click' } },
		]);
});
