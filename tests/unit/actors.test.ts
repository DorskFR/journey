import { expect, test } from '@playwright/test';
import type { Interaction, IRStep } from '../../src/core/types.js';
import {
	DriverActor,
	type DriverYield,
	domActor,
	humanActor,
	MARKER,
	steppedActor,
} from '../../src/runtime/actors.js';
import type { ActorCtx, Presenter } from '../../src/runtime/engine.js';
import { type FakeDom, type FakeElement, installDom, journeyEl } from './fake-dom.js';

let dom: FakeDom;
test.beforeEach(() => {
	dom = installDom('http://app.test/notes?journey=run');
});
test.afterEach(() => dom.restore());

function step(action: Interaction, extra: Partial<IRStep> = {}): IRStep {
	return { id: 's', target: 't', do: action, guide: 'wait-for-user', timeout: 300, ...extra };
}

interface Harness {
	ctx: ActorCtx;
	controller: AbortController;
	next: () => void;
	messages: string[];
	acted: number;
}

function harness(extra: Partial<ActorCtx> = {}): Harness {
	const controller = new AbortController();
	let next: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		next = resolve;
	});
	const h: Harness = {
		controller,
		next: () => next(),
		messages: [],
		acted: 0,
		ctx: undefined as unknown as ActorCtx,
	};
	const presenter: Presenter = {
		show() {},
		settle() {},
		hide() {},
		message: (title, body, _exit, onNext) => {
			h.messages.push(`${title}: ${body}`);
			if (onNext) h.next = onNext;
		},
	};
	h.ctx = {
		signal: controller.signal,
		next: promise,
		presenter,
		params: {},
		exit: () => controller.abort(),
		proceed: () => next(),
		markActed: () => {
			h.acted += 1;
		},
		...extra,
	};
	return h;
}

function record(el: FakeElement, types: string[]): string[] {
	const seen: string[] = [];
	for (const type of types) {
		el.addEventListener(type, (event) => {
			const detail = (event as MouseEvent).detail;
			seen.push(detail === undefined ? type : `${type}:${detail}`);
		});
	}
	return seen;
}

const POINTER = [
	'pointerover',
	'pointerenter',
	'mouseover',
	'mouseenter',
	'pointermove',
	'mousemove',
	'pointerdown',
	'mousedown',
	'pointerup',
	'mouseup',
	'click',
	'dblclick',
];

const settled = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('a dom click hovers, presses and clicks in the order a real pointer does, and focuses', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const seen = record(button, POINTER);
	await domActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		harness().ctx,
	);
	expect(seen).toEqual([
		'pointerover',
		'pointerenter',
		'mouseover',
		'mouseenter',
		'pointermove',
		'mousemove',
		'pointerdown:1',
		'mousedown:1',
		'pointerup:1',
		'mouseup:1',
		'click:1',
	]);
	expect(dom.document.activeElement === button).toBe(true);
});

test('a dom double click sends two clicks with rising detail, then dblclick', async () => {
	const cell = journeyEl(dom, 't', { tag: 'button' });
	const seen = record(cell, ['click', 'dblclick']);
	await domActor.perform(
		step({ kind: 'dblclick' }),
		cell as unknown as Element,
		{ kind: 'dblclick' },
		harness().ctx,
	);
	expect(seen).toEqual(['click:1', 'click:2', 'dblclick:2']);
});

test('a dom click on a disabled control sends nothing', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	button.disabled = true;
	const seen = record(button, POINTER);
	await domActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		harness().ctx,
	);
	expect(seen).toEqual([]);
});

test('a cancelled pointerdown skips mousedown and mouseup but still focuses and clicks', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	button.addEventListener('pointerdown', (event) => event.preventDefault());
	const seen = record(button, ['mousedown', 'mouseup', 'click']);
	await domActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		harness().ctx,
	);
	expect(seen).toEqual(['click:1']);
	expect(dom.document.activeElement === button).toBe(true);
});

test('a dom fill types the value with beforeinput, input and change', async () => {
	const input = journeyEl(dom, 't', { tag: 'input' });
	const seen: string[] = [];
	for (const type of ['beforeinput', 'input', 'change']) {
		input.addEventListener(type, () => seen.push(`${type}=${input.value}`));
	}
	const action: Interaction = { kind: 'fill', value: 'Ada' };
	await domActor.perform(step(action), input as unknown as Element, action, harness().ctx);
	expect(input.value).toBe('Ada');
	expect(seen).toEqual(['beforeinput=', 'input=Ada', 'change=Ada']);
});

test('a cancelled beforeinput leaves the field as it was', async () => {
	const input = journeyEl(dom, 't', { tag: 'input' });
	input.value = 'kept';
	input.addEventListener('beforeinput', (event) => event.preventDefault());
	const action: Interaction = { kind: 'fill', value: 'Ada' };
	await domActor.perform(step(action), input as unknown as Element, action, harness().ctx);
	expect(input.value).toBe('kept');
});

test('a dom select picks an option by value or label and fires input and change', async () => {
	const select = journeyEl(dom, 't', { tag: 'select' });
	for (const [value, label] of [
		['fr', 'French'],
		['ja', 'Japanese'],
	]) {
		const option = dom.document.createElement('option', { value: value as string });
		option.ownText = label as string;
		select.append(option);
	}
	const seen = record(select, ['input', 'change']);
	const byLabel: Interaction = { kind: 'select', value: 'Japanese' };
	await domActor.perform(step(byLabel), select as unknown as Element, byLabel, harness().ctx);
	expect(select.value).toBe('ja');
	const byValue: Interaction = { kind: 'select', value: 'fr' };
	await domActor.perform(step(byValue), select as unknown as Element, byValue, harness().ctx);
	expect(select.value).toBe('fr');
	expect(seen).toEqual(['input', 'change', 'input', 'change']);
	const missing: Interaction = { kind: 'select', value: 'German' };
	await expect(
		domActor.perform(step(missing), select as unknown as Element, missing, harness().ctx),
	).rejects.toThrow('step s: no option "German" to select');
});

test('a dom check clicks the box, and fails when the click does not toggle it', async () => {
	const box = journeyEl(dom, 't', { tag: 'input' });
	box.setAttribute('type', 'checkbox');
	const check: Interaction = { kind: 'check', checked: true };
	await expect(
		domActor.perform(step(check), box as unknown as Element, check, harness().ctx),
	).rejects.toThrow('step s: clicking did not check the target');
	box.addEventListener('click', () => {
		box.checked = !box.checked;
	});
	await domActor.perform(step(check), box as unknown as Element, check, harness().ctx);
	expect(box.checked).toBe(true);
	const seen = record(box, ['click']);
	await domActor.perform(step(check), box as unknown as Element, check, harness().ctx);
	expect(seen).toEqual([]);
});

test('a dom press sends keydown, keypress and keyup with the key code, and Enter activates a button', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const keys: string[] = [];
	for (const type of ['keydown', 'keypress', 'keyup']) {
		button.addEventListener(type, (event) => {
			const e = event as KeyboardEvent;
			keys.push(`${type} ${e.key} ${e.code}${e.ctrlKey ? ' ctrl' : ''}`);
		});
	}
	const clicks = record(button, ['click']);
	const enter: Interaction = { kind: 'press', key: 'Enter' };
	await domActor.perform(step(enter), button as unknown as Element, enter, harness().ctx);
	expect(keys).toEqual(['keydown Enter Enter', 'keypress Enter Enter', 'keyup Enter Enter']);
	expect(clicks).toEqual(['click:1']);
	keys.length = 0;
	const chord: Interaction = { kind: 'press', key: 'Control+a' };
	await domActor.perform(step(chord), button as unknown as Element, chord, harness().ctx);
	expect(keys).toEqual(['keydown a KeyA ctrl', 'keyup a KeyA ctrl']);
});

test('an action that needs a target fails clearly without one', async () => {
	await expect(
		domActor.perform(step({ kind: 'click' }), null, { kind: 'click' }, harness().ctx),
	).rejects.toThrow('step s: interaction "click" needs a target');
});

test('dom navigate keeps the run flag on other pages and only changes the hash on this one', async () => {
	await domActor.navigate('/settings', harness().ctx);
	expect(dom.location.assigned).toEqual(['http://app.test/settings?journey=run']);
	await domActor.navigate('/notes#archived', harness().ctx);
	expect(dom.location.hash).toBe('#archived');
	expect(dom.location.assigned).toHaveLength(1);
	await domActor.navigate('/other?journey=off', harness().ctx);
	expect(dom.location.assigned.at(-1)).toBe('http://app.test/other?journey=off');
});

test('the human actor waits for the user to click the target and does not click again', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const h = harness();
	let done = false;
	const waiting = humanActor
		.perform(step({ kind: 'click' }), button as unknown as Element, { kind: 'click' }, h.ctx)
		.then(() => {
			done = true;
		});
	await settled();
	expect(done).toBe(false);
	const clicks = record(button, ['click']);
	button.dispatchEvent(new Event('click'));
	await waiting;
	expect(clicks).toEqual(['click']);
});

test('the human actor performs the step itself when the user presses Next', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const clicks = record(button, ['click']);
	const h = harness();
	const waiting = humanActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		h.ctx,
	);
	await settled();
	h.next();
	await waiting;
	expect(clicks).toEqual(['click:1']);
});

test('the human actor stops waiting on abort without acting', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const clicks = record(button, ['click']);
	const h = harness();
	const waiting = humanActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		h.ctx,
	);
	h.controller.abort();
	await waiting;
	expect(clicks).toEqual([]);
});

test('a literal human fill only counts once the field holds the expected value', async () => {
	const input = journeyEl(dom, 't', { tag: 'input' });
	const action: Interaction = { kind: 'fill', value: 'Ada' };
	let done = false;
	const waiting = humanActor
		.perform(step(action), input as unknown as Element, action, harness().ctx)
		.then(() => {
			done = true;
		});
	input.value = 'Ad';
	input.dispatchEvent(new Event('input'));
	await settled();
	expect(done).toBe(false);
	input.value = 'Ada';
	input.dispatchEvent(new Event('input'));
	await waiting;
});

test('a human fill of a param counts any input', async () => {
	const input = journeyEl(dom, 't', { tag: 'input' });
	const action: Interaction = { kind: 'fill', value: 'secret' };
	const waiting = humanActor.perform(
		step({ kind: 'fill', value: { $param: 'pin' } }),
		input as unknown as Element,
		action,
		harness().ctx,
	);
	input.value = 'x';
	input.dispatchEvent(new Event('change'));
	await waiting;
	expect(input.value).toBe('x');
});

test('a human press waits for that key only', async () => {
	const input = journeyEl(dom, 't', { tag: 'input' });
	const action: Interaction = { kind: 'press', key: 'Enter' };
	let done = false;
	const waiting = humanActor
		.perform(step(action), input as unknown as Element, action, harness().ctx)
		.then(() => {
			done = true;
		});
	input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'a' }));
	await settled();
	expect(done).toBe(false);
	input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
	await waiting;
});

test('the human actor asks the user to change page and navigates through the host hook', async () => {
	const routes: string[] = [];
	const h = harness({ navigate: (route) => void routes.push(route) });
	await humanActor.navigate('/settings', h.ctx);
	expect(h.messages).toEqual(['Go to another page: Open /settings to continue.']);
	expect(routes).toEqual([]);
	h.next();
	expect(routes).toEqual(['/settings']);
});

test('the stepped actor acts only after Next', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const clicks = record(button, ['click']);
	const h = harness();
	const waiting = steppedActor.perform(
		step({ kind: 'click' }),
		button as unknown as Element,
		{ kind: 'click' },
		h.ctx,
	);
	await settled();
	expect(clicks).toEqual([]);
	h.ctx.proceed();
	await waiting;
	expect(clicks).toEqual(['click:1']);
	await steppedActor.navigate('/settings', h.ctx);
	expect(h.messages).toEqual(['Go to another page: Press Next to open /settings.']);
	expect(dom.location.assigned).toEqual(['http://app.test/settings?journey=run']);
});

test('the driver actor yields each action with a focus marker until acted() is called', async () => {
	const button = journeyEl(dom, 't', { tag: 'button' });
	const actor = new DriverActor();
	const yields: DriverYield[] = [];
	actor.onYield = (y) => yields.push(y);
	const h = harness();
	let done = false;
	const performing = actor
		.perform(step({ kind: 'click' }), button as unknown as Element, { kind: 'click' }, h.ctx)
		.then(() => {
			done = true;
		});
	expect(yields).toEqual([{ stepId: 's', action: { kind: 'click' }, marker: 's' }]);
	expect(actor.pending).toEqual(yields[0]);
	expect(button.getAttribute(MARKER)).toBe('s');
	expect(h.acted).toBe(1);
	await settled();
	expect(done).toBe(false);
	actor.acted();
	await performing;
	expect(actor.pending).toBeNull();
	expect(button.hasAttribute(MARKER)).toBe(false);
});

test('the driver actor yields no action or marker for a none step, and routes for navigation', async () => {
	const actor = new DriverActor();
	const yields: DriverYield[] = [];
	actor.onYield = (y) => yields.push(y);
	const h = harness();
	const none = actor.perform(step({ kind: 'none' }), null, { kind: 'none' }, h.ctx);
	expect(h.acted).toBe(0);
	actor.acted();
	await none;
	const nav = actor.navigate('/settings', h.ctx);
	expect(yields).toEqual([
		{ stepId: 's', action: null, marker: null },
		{ stepId: '', route: '/settings' },
	]);
	h.controller.abort();
	await nav;
});

test('the driver actor holds after a step until proceed(), and abort releases it', async () => {
	const actor = new DriverActor();
	const h = harness();
	let done = false;
	const after = actor.afterStep(step({ kind: 'none' }), 0, h.ctx).then(() => {
		done = true;
	});
	await settled();
	expect(done).toBe(false);
	actor.proceed();
	await after;
	const held = actor.afterStep(step({ kind: 'none' }), 1, h.ctx);
	h.controller.abort();
	await held;
});
