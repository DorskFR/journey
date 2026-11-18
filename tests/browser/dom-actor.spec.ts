import { expect, type Page, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import type { RunResult } from '../../src/runtime/index.js';
import { BASE, ir, mountRuntime, RUNTIME_INIT, waitForApi } from './helpers.js';

const FIXTURE = `
<div id="fx">
	<button type="button" data-journey="trigger">Open</button>
	<ul data-journey="menu" hidden><li>Item</li></ul>
	<svg data-journey="icon" width="20" height="20"><rect width="20" height="20"></rect></svg>
	<input data-journey="name">
	<input type="checkbox" data-journey="agree">
	<div contenteditable="true" data-journey="rich"></div>
	<form data-journey="search"><input data-journey="q"><button>Go</button></form>
	<input data-journey="after">
	<select data-journey="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
</div>`;

type Log = { events: string[]; clickX: number; submitted: number; inputType: string };

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/`);
	await mountRuntime(page);
	await waitForApi(page);
	await page.evaluate((html) => {
		document.body.insertAdjacentHTML('afterbegin', html);
		const $ = (name: string) => document.querySelector(`[data-journey="${name}"]`) as HTMLElement;
		const log: Log = { events: [], clickX: 0, submitted: 0, inputType: '' };
		(window as unknown as { __log: Log }).__log = log;
		const trigger = $('trigger');
		for (const type of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
			trigger.addEventListener(type, (event) => {
				log.events.push(type);
				if (type === 'click') log.clickX = (event as MouseEvent).clientX;
			});
		}
		trigger.addEventListener('pointerdown', () => {
			$('menu').hidden = false;
		});
		$('icon').addEventListener('click', () => {
			$('icon').dataset.clicked = 'yes';
		});
		$('rich').addEventListener('input', (event) => {
			log.inputType = (event as InputEvent).inputType;
		});
		$('search').addEventListener('submit', (event) => {
			event.preventDefault();
			log.submitted++;
		});
		// A value tracker in the style of React's: writes through the instance
		// property update the tracked value, so only a native edit reads as a change.
		const track = (el: HTMLInputElement, prop: 'value' | 'checked', on: string): void => {
			const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, prop);
			if (!proto?.get || !proto.set) return;
			const get = proto.get;
			const set = proto.set;
			let tracked = get.call(el);
			Object.defineProperty(el, prop, {
				configurable: true,
				get: () => get.call(el),
				set: (v) => {
					tracked = v;
					set.call(el, v);
				},
			});
			el.addEventListener(on, () => {
				const now = get.call(el);
				if (now === tracked) return;
				tracked = now;
				el.dataset.changes = String(Number(el.dataset.changes ?? 0) + 1);
			});
		};
		track($('name') as HTMLInputElement, 'value', 'input');
		track($('agree') as HTMLInputElement, 'checked', 'click');
	}, FIXTURE);
});

async function run(page: Page, steps: Journey['steps']): Promise<RunResult> {
	const journey = ir({ id: 'actor', route: '/', steps });
	await page.evaluate((j) => window.__journey?.register([j]), journey);
	return (await page.evaluate(() =>
		window.__journey?.start('actor', { mode: 'run' }),
	)) as RunResult;
}

function log(page: Page): Promise<Log> {
	return page.evaluate(() => (window as unknown as { __log: Log }).__log);
}

function attr(page: Page, name: string, key: string): Promise<string | null> {
	return page.evaluate(
		([n, k]) => document.querySelector(`[data-journey="${n}"]`)?.getAttribute(k) ?? null,
		[name, key] as const,
	);
}

test('click dispatches the full pointer and mouse sequence with coordinates', async ({ page }) => {
	const result = await run(page, [
		{ id: 'open', target: 'trigger', do: { kind: 'click' }, expect: [{ visible: 'menu' }] },
	]);
	expect(result).toMatchObject({ ok: true, completed: 1 });
	const { events, clickX } = await log(page);
	expect(events).toEqual(['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']);
	expect(clickX).toBeGreaterThan(0);
});

test('click works on an SVG target', async ({ page }) => {
	const result = await run(page, [{ id: 'svg', target: 'icon', do: { kind: 'click' } }]);
	expect(result).toMatchObject({ ok: true, completed: 1 });
	expect(await attr(page, 'icon', 'data-clicked')).toBe('yes');
});

test('fill reaches a tracked input as a native edit', async ({ page }) => {
	const result = await run(page, [
		{ id: 'name', target: 'name', do: { kind: 'fill', value: 'Ada' } },
	]);
	expect(result).toMatchObject({ ok: true });
	expect(await page.locator('[data-journey="name"]').inputValue()).toBe('Ada');
	expect(await attr(page, 'name', 'data-changes')).toBe('1');
});

test('check toggles a tracked checkbox through a click', async ({ page }) => {
	const result = await run(page, [
		{ id: 'agree', target: 'agree', do: { kind: 'check', checked: true } },
	]);
	expect(result).toMatchObject({ ok: true });
	await expect(page.locator('[data-journey="agree"]')).toBeChecked();
	expect(await attr(page, 'agree', 'data-changes')).toBe('1');
});

test('fill types into a contenteditable element', async ({ page }) => {
	const result = await run(page, [
		{ id: 'rich', target: 'rich', do: { kind: 'fill', value: 'Hello' } },
	]);
	expect(result).toMatchObject({ ok: true });
	await expect(page.locator('[data-journey="rich"]')).toHaveText('Hello');
	expect((await log(page)).inputType).toBe('insertText');
});

test('Enter in a form field submits the form', async ({ page }) => {
	const result = await run(page, [
		{ id: 'q', target: 'search/q', do: { kind: 'fill', value: 'milk' } },
		{ id: 'enter', target: 'search/q', do: { kind: 'press', key: 'Enter' } },
	]);
	expect(result).toMatchObject({ ok: true });
	expect((await log(page)).submitted).toBe(1);
});

test('Tab moves focus to the next control', async ({ page }) => {
	const result = await run(page, [
		{ id: 'tab', target: 'search/q', do: { kind: 'press', key: 'Tab' } },
	]);
	expect(result).toMatchObject({ ok: true });
	expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Go');
});

test('a typed key goes to the focused field', async ({ page }) => {
	const result = await run(page, [{ id: 'key', target: 'after', do: { kind: 'press', key: 'x' } }]);
	expect(result).toMatchObject({ ok: true });
	expect(await page.locator('[data-journey="after"]').inputValue()).toBe('x');
});

test('select matches an option by label and fails on a missing one', async ({ page }) => {
	const ok = await run(page, [
		{ id: 'pick', target: 'pick', do: { kind: 'select', value: 'Banana' } },
	]);
	expect(ok).toMatchObject({ ok: true });
	expect(await page.locator('[data-journey="pick"]').inputValue()).toBe('b');

	await page.evaluate(() => {
		(document.querySelector('[data-journey="pick"]') as HTMLSelectElement).value = 'a';
	});
	const missing = await run(page, [
		{ id: 'pick', target: 'pick', do: { kind: 'select', value: 'Cherry' } },
	]);
	expect(missing.ok).toBe(false);
	expect(missing.failures[0]?.error).toContain('no option "Cherry"');
	expect(await page.locator('[data-journey="pick"]').inputValue()).toBe('a');
});
