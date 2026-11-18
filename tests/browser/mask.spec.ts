import { expect, type Page, test } from '@playwright/test';
import type { IR } from '../../src/index.js';
import { captureStep, runJourney } from '../../src/playwright/index.js';

const ORIGIN = 'http://mask.test';
const SECRET = 'sk-live-4242';

const PAGE = `<!doctype html><html><head><title>mask</title></head><body>
<main>
<button data-journey="reveal">Reveal</button>
<button data-journey="rerender">Re-render</button>
<label>API key <input data-journey="key" name="apikey"></label>
<div id="slot"></div>
</main>
<script>
window.frames_ = [];
const firstFrame = (label, el) => requestAnimationFrame(() =>
	window.frames_.push([label, el.hasAttribute('data-journey-mask')]));
document.querySelector('[data-journey="reveal"]').addEventListener('click', () => {
	const p = document.createElement('p');
	p.setAttribute('data-journey', 'secret');
	p.textContent = '${SECRET}';
	document.getElementById('slot').append(p);
	firstFrame('revealed', p);
});
document.querySelector('[data-journey="rerender"]').addEventListener('click', () => {
	const old = document.querySelector('[data-journey="secret"]');
	old.removeAttribute('data-journey-mask');
	firstFrame('stripped', old);
	const input = document.querySelector('[data-journey="key"]');
	const fresh = input.cloneNode();
	fresh.removeAttribute('data-journey-mask');
	fresh.value = input.value;
	input.replaceWith(fresh);
	firstFrame('replaced', fresh);
});
document.querySelector('[data-journey="key"]').addEventListener('input', (e) =>
	window.frames_.push(['typed', e.target.hasAttribute('data-journey-mask')]));
</script>
</body></html>`;

async function serve(page: Page): Promise<void> {
	await page.route(`${ORIGIN}/**`, (route) =>
		route.fulfill({ contentType: 'text/html', body: PAGE }),
	);
}

const journey: IR = {
	id: 'masks',
	version: 1,
	route: '/',
	level: 'smoke',
	mask: ['secret'],
	steps: [
		{
			id: 'type-key',
			target: 'key',
			do: { kind: 'fill', value: { $param: 'var.key' }, mask: true },
			capture: { name: 'typed' },
			guide: 'wait-for-user',
			timeout: 2000,
		},
		{
			id: 'reveal',
			target: 'reveal',
			do: { kind: 'click' },
			capture: { name: 'revealed' },
			guide: 'wait-for-user',
			timeout: 2000,
		},
		{
			id: 'rerender',
			target: 'rerender',
			do: { kind: 'click' },
			capture: { name: 'rerendered' },
			guide: 'wait-for-user',
			timeout: 2000,
		},
	],
};

interface Shot {
	name: string;
	secret: string | null;
	key: string | null;
	value: string;
}

function state(page: Page): Promise<Omit<Shot, 'name'>> {
	return page.evaluate(() => {
		const filter = (sel: string): string | null => {
			const el = document.querySelector(sel);
			return el?.hasAttribute('data-journey-mask') ? getComputedStyle(el).filter : null;
		};
		return {
			secret: filter('[data-journey="secret"]'),
			key: filter('[data-journey="key"]'),
			value: (document.querySelector('[data-journey="key"]') as HTMLInputElement).value,
		};
	});
}

async function run(page: Page, mask: boolean): Promise<Shot[]> {
	await serve(page);
	const shots: Shot[] = [];
	const result = await runJourney(page, journey, {
		baseUrl: ORIGIN,
		params: { 'var.key': SECRET },
		mask,
		async onCapture(spec, ctx) {
			const shot = { name: spec.name, ...(await state(page)) };
			expect((await captureStep(page, spec, ctx)).length).toBeGreaterThan(0);
			shots.push(shot);
		},
	});
	expect(result.ok, JSON.stringify(result.failures)).toBe(true);
	return shots;
}

test('book mode masks what the action reveals, in every frame and at capture time', async ({
	page,
}) => {
	const shots = await run(page, true);
	expect(shots.map((s) => [s.name, s.secret])).toEqual([
		['typed', null],
		['revealed', 'blur(8px)'],
		['rerendered', 'blur(8px)'],
	]);
	const frames = await page.evaluate(() => (window as unknown as { frames_: unknown[] }).frames_);
	expect(frames).toEqual([
		['typed', true],
		['revealed', true],
		['stripped', true],
		['replaced', true],
	]);
	expect(await state(page)).toEqual({ secret: 'blur(8px)', key: 'blur(8px)', value: SECRET });
});

test('a masked fill types the real value into a field that is masked before and after', async ({
	page,
}) => {
	const shots = await run(page, false);
	expect(shots.map((s) => [s.name, s.key, s.value])).toEqual([
		['typed', 'blur(8px)', SECRET],
		['revealed', 'blur(8px)', SECRET],
		['rerendered', 'blur(8px)', SECRET],
	]);
	expect(shots.every((s) => s.secret === null)).toBe(true);
	const frames = await page.evaluate(() => (window as unknown as { frames_: unknown[] }).frames_);
	expect(frames).toContainEqual(['typed', true]);
	expect(frames).toContainEqual(['replaced', true]);
	expect(await state(page)).toEqual({ secret: null, key: null, value: SECRET });
});
