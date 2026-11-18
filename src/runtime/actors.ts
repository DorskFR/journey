import type { Interaction, IRStep } from '../core/types.js';
import type { Actor, ActorCtx } from './engine.js';
import { isParamRef } from './text.js';

function keyCode(key: string): string {
	if (key.length === 1) {
		if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
		if (/[0-9]/.test(key)) return `Digit${key}`;
		if (key === ' ') return 'Space';
	}
	return key;
}

function nativeSetter(el: Element, prop: 'value' | 'checked'): ((value: unknown) => void) | null {
	const proto =
		el instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: el instanceof HTMLInputElement
				? HTMLInputElement.prototype
				: el instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: null;
	if (!proto) return null;
	const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
	return descriptor?.set ? (value) => descriptor.set?.call(el, value) : null;
}

function fire(el: Element, type: string, init: EventInit = {}): boolean {
	return el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

const FOCUSABLE =
	'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]:not([contenteditable="false"])';

function deepActive(): Element | null {
	let el = document.activeElement;
	while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
	return el;
}

function focusable(el: Element): el is HTMLElement | SVGElement {
	return (
		(el instanceof HTMLElement || el instanceof SVGElement) &&
		el.matches(FOCUSABLE) &&
		!el.matches(':disabled')
	);
}

// A real press focuses the nearest focusable ancestor, or blurs when there is none.
function focusFrom(el: Element): void {
	for (let node: Element | null = el; node; node = node.parentElement) {
		if (focusable(node)) {
			node.focus({ preventScroll: true });
			return;
		}
	}
	const active = deepActive();
	if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
}

function pointAt(el: Element): MouseEventInit {
	const rect = el.getBoundingClientRect();
	return {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		clientX: rect.left + rect.width / 2,
		clientY: rect.top + rect.height / 2,
		button: 0,
	};
}

function pointer(el: Element, type: string, init: MouseEventInit): boolean {
	const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
	return el.dispatchEvent(
		new Ctor(type, {
			...init,
			pointerId: 1,
			pointerType: 'mouse',
			isPrimary: true,
		} as MouseEventInit),
	);
}

function hover(el: Element): void {
	const at = pointAt(el);
	pointer(el, 'pointerover', at);
	pointer(el, 'pointerenter', { ...at, bubbles: false });
	el.dispatchEvent(new MouseEvent('mouseover', at));
	el.dispatchEvent(new MouseEvent('mouseenter', { ...at, bubbles: false }));
	pointer(el, 'pointermove', at);
	el.dispatchEvent(new MouseEvent('mousemove', at));
}

function clickOnce(el: Element, detail: number): void {
	const at = { ...pointAt(el), detail };
	const down = pointer(el, 'pointerdown', { ...at, buttons: 1 });
	const mouseDown = down
		? el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }))
		: true;
	if (mouseDown) focusFrom(el);
	pointer(el, 'pointerup', at);
	if (down) el.dispatchEvent(new MouseEvent('mouseup', at));
	el.dispatchEvent(new MouseEvent('click', at));
}

function click(el: Element, count = 1): void {
	if (el.matches(':disabled')) return;
	hover(el);
	for (let i = 1; i <= count; i++) clickOnce(el, i);
	if (count === 2) el.dispatchEvent(new MouseEvent('dblclick', { ...pointAt(el), detail: 2 }));
}

const TEXT_INPUT =
	'input:not([type]),input[type=text],input[type=search],input[type=url],input[type=tel],input[type=password],input[type=email],input[type=number]';

function insertFallback(el: HTMLElement, value: string): void {
	const init = {
		bubbles: true,
		cancelable: true,
		composed: true,
		inputType: 'insertText',
		data: value,
	};
	if (!el.dispatchEvent(new InputEvent('beforeinput', init))) return;
	const setter = nativeSetter(el, 'value');
	if (setter) setter(value);
	else if (el.isContentEditable) el.textContent = value;
	else (el as HTMLInputElement).value = value;
	el.dispatchEvent(new InputEvent('input', { ...init, cancelable: false }));
}

// The editing command makes the browser edit the field itself, as typing does,
// so value trackers and editors that handle beforeinput see a native edit.
function typeInto(el: HTMLElement, value: string): void {
	el.focus({ preventScroll: true });
	const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
	const editable = field
		? field instanceof HTMLTextAreaElement || field.matches(TEXT_INPUT)
		: el.isContentEditable;
	if (!editable || deepActive() !== el) {
		insertFallback(el, value);
		return;
	}
	const before = field?.value;
	if (field) field.select();
	else {
		const range = document.createRange();
		range.selectNodeContents(el);
		const selection = getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}
	let done = false;
	try {
		done =
			value === ''
				? document.execCommand('delete', false)
				: document.execCommand('insertText', false, value);
	} catch {}
	if (!done || (field && field.value === before && before !== value)) insertFallback(el, value);
}

function tabbables(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)]
		.filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0)
		.map((el, i) => ({ el, i }))
		.sort((a, b) => (a.el.tabIndex || 1e9) - (b.el.tabIndex || 1e9) || a.i - b.i)
		.map(({ el }) => el);
}

function moveFocus(from: Element, back: boolean): void {
	const list = tabbables();
	if (list.length === 0) return;
	const at = list.indexOf(from as HTMLElement);
	const next =
		at < 0 ? (back ? list.length - 1 : 0) : (at + (back ? -1 : 1) + list.length) % list.length;
	list[next]?.focus();
}

function implicitSubmit(el: Element): void {
	if (!el.matches(TEXT_INPUT)) return;
	const form = (el as HTMLInputElement).form;
	if (!form) return;
	const submitter = [...form.elements].find((c) =>
		c.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]'),
	) as HTMLButtonElement | HTMLInputElement | undefined;
	if (submitter?.disabled) return;
	form.requestSubmit(submitter);
}

const ACTIVATES = 'button,a[href],summary,input[type=submit],input[type=button],input[type=reset]';

function typeChar(el: Element, key: string): void {
	if (!(el instanceof HTMLElement) || deepActive() !== el) return;
	const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
	const editable = field
		? field instanceof HTMLTextAreaElement || field.matches(TEXT_INPUT)
		: el.isContentEditable;
	if (!editable) return;
	let done = false;
	try {
		done = document.execCommand('insertText', false, key);
	} catch {}
	if (!done) insertFallback(el, `${field ? field.value : (el.textContent ?? '')}${key}`);
}

function parseKey(spec: string): { key: string; mods: Set<string> } {
	const parts = spec.length > 1 ? spec.split(/\+(?!$)/) : [spec];
	const key = parts.pop() ?? spec;
	return { key, mods: new Set(parts) };
}

function press(target: Element, spec: string): void {
	if (!target.contains(deepActive())) focusFrom(target);
	const active = deepActive();
	const el = active && target.contains(active) ? active : target;
	const { key, mods } = parseKey(spec);
	const init: KeyboardEventInit = {
		key,
		code: keyCode(key),
		bubbles: true,
		cancelable: true,
		composed: true,
		shiftKey: mods.has('Shift'),
		ctrlKey: mods.has('Control'),
		altKey: mods.has('Alt'),
		metaKey: mods.has('Meta'),
	};
	const chord = init.ctrlKey || init.altKey || init.metaKey;
	const printable = key.length === 1 && !chord;
	let proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
	if (proceed && (printable || key === 'Enter')) {
		proceed = el.dispatchEvent(new KeyboardEvent('keypress', init));
	}
	if (proceed && !chord) {
		if (key === 'Tab') moveFocus(el, init.shiftKey === true);
		else if (key === 'Enter' && el.matches(ACTIVATES)) click(el);
		else if (key === 'Enter') implicitSubmit(el);
		else if (printable) typeChar(el, key);
	}
	const up = el.dispatchEvent(new KeyboardEvent('keyup', init));
	if (
		up &&
		proceed &&
		key === ' ' &&
		el.matches(`${ACTIVATES},input[type=checkbox],input[type=radio]`)
	) {
		click(el);
	}
}

function waitEvent(
	el: Element,
	type: string,
	ctx: ActorCtx,
	accept: (event: Event) => boolean = () => true,
): Promise<void> {
	return new Promise((resolve) => {
		const controller = new AbortController();
		const finish = (): void => {
			controller.abort();
			resolve();
		};
		el.addEventListener(
			type,
			(event) => {
				if (accept(event)) finish();
			},
			{ capture: true, signal: controller.signal },
		);
		ctx.signal.addEventListener('abort', finish, { once: true, signal: controller.signal });
		ctx.next.then(finish);
	});
}

function requireEl(step: IRStep, el: Element | null): Element {
	if (!el) throw new Error(`step ${step.id}: interaction "${step.do.kind}" needs a target`);
	return el;
}

function assignRoute(route: string): void {
	const hash = route.indexOf('#');
	if (hash > 0 && route.slice(0, hash) === location.pathname) {
		location.hash = route.slice(hash);
		return;
	}
	const url = new URL(route, location.href);
	const flag = new URLSearchParams(location.search).get('journey');
	if (flag !== null && !url.searchParams.has('journey')) url.searchParams.set('journey', flag);
	location.href = url.href;
}

export const domActor: Actor = {
	async navigate(route) {
		assignRoute(route);
	},
	async perform(step, el, action) {
		switch (action.kind) {
			case 'none':
				return;
			case 'navigate':
				location.href = action.url;
				return;
			case 'click':
				click(requireEl(step, el));
				return;
			case 'dblclick':
				click(requireEl(step, el), 2);
				return;
			case 'fill': {
				const target = requireEl(step, el) as HTMLElement;
				typeInto(target, action.value as string);
				if (!target.isContentEditable) fire(target, 'change');
				return;
			}
			case 'select': {
				const target = requireEl(step, el) as HTMLSelectElement;
				const wanted = action.value as string;
				const options = [...target.options];
				const option =
					options.find((o) => o.value === wanted) ??
					options.find((o) => o.label === wanted || o.text.trim() === wanted);
				if (!option) throw new Error(`step ${step.id}: no option "${wanted}" to select`);
				target.focus({ preventScroll: true });
				const setter = nativeSetter(target, 'value');
				if (setter) setter(option.value);
				else target.value = option.value;
				fire(target, 'input');
				fire(target, 'change');
				return;
			}
			case 'check': {
				const target = requireEl(step, el) as HTMLInputElement;
				if (target.checked === action.checked) return;
				if (target.type === 'radio' && !action.checked) {
					nativeSetter(target, 'checked')?.(false);
					fire(target, 'input');
					fire(target, 'change');
					return;
				}
				click(target);
				if (target.checked !== action.checked) {
					throw new Error(
						`step ${step.id}: clicking did not ${action.checked ? 'check' : 'uncheck'} the target`,
					);
				}
				return;
			}
			case 'press':
				press(requireEl(step, el), action.key);
				return;
			case 'hover':
				hover(requireEl(step, el));
				return;
		}
	},
};

export const steppedActor: Actor = {
	stepped: true,
	async navigate(route, ctx) {
		ctx.presenter.message?.(
			'Go to another page',
			`Press Next to open ${route}.`,
			ctx.exit,
			ctx.proceed,
		);
		await ctx.next;
		if (!ctx.signal.aborted) await domActor.navigate(route, ctx);
	},
	async perform(step, el, action, ctx) {
		await ctx.next;
		if (!ctx.signal.aborted) await domActor.perform(step, el, action, ctx);
	},
};

export const humanActor: Actor = {
	human: true,
	async navigate(route, ctx) {
		ctx.presenter.message?.('Go to another page', `Open ${route} to continue.`, ctx.exit, () => {
			const hook = ctx.navigate;
			if (hook) void hook(route);
			else location.href = route;
		});
	},
	async perform(step, el, action, ctx) {
		if (action.kind === 'none' || action.kind === 'navigate') {
			await ctx.next;
			if (action.kind === 'navigate' && !ctx.signal.aborted) location.href = action.url;
			return;
		}
		const target = requireEl(step, el);
		let viaNext = true;
		const wait = (type: string, accept?: (event: Event) => boolean): Promise<void> =>
			waitEvent(target, type, ctx, (event) => {
				const ok = accept ? accept(event) : true;
				if (ok) viaNext = false;
				return ok;
			});
		switch (action.kind) {
			case 'click':
			case 'dblclick':
				await wait(action.kind);
				break;
			case 'fill': {
				const literal = !isParamRef(step.do.kind === 'fill' ? step.do.value : undefined);
				const matches = (): boolean =>
					!literal || (target as HTMLInputElement).value === (action.value as string);
				await Promise.race([wait('input', matches), wait('change', matches)]);
				break;
			}
			case 'select':
			case 'check':
				await wait('change');
				break;
			case 'press':
				await wait('keydown', (event) => (event as KeyboardEvent).key === action.key);
				break;
			case 'hover':
				await wait('pointerenter');
				break;
		}
		if (viaNext && !ctx.signal.aborted) await domActor.perform(step, el, action, ctx);
	},
};

export interface DriverYield {
	stepId: string;
	route?: string;
	action?: Interaction | null;
	marker?: string | null;
}

export const MARKER = 'data-journey-focus';

export class DriverActor implements Actor {
	pending: DriverYield | null = null;
	onYield: ((y: DriverYield) => void) | null = null;
	private actedResolve: (() => void) | null = null;
	private proceedResolve: (() => void) | null = null;

	acted(): void {
		const resolve = this.actedResolve;
		this.actedResolve = null;
		resolve?.();
	}

	proceed(): void {
		const resolve = this.proceedResolve;
		this.proceedResolve = null;
		resolve?.();
	}

	navigate(route: string, ctx: ActorCtx): Promise<void> {
		return new Promise<void>((resolve) => {
			ctx.signal.addEventListener('abort', () => resolve(), { once: true });
			this.pending = { stepId: '', route };
			this.onYield?.(this.pending);
		});
	}

	perform(step: IRStep, el: Element | null, action: Interaction, ctx: ActorCtx): Promise<void> {
		return this.yieldAction(step, el, action.kind === 'none' ? null : action, ctx);
	}

	resume(step: IRStep, ctx: ActorCtx): Promise<void> {
		return this.yieldAction(step, null, null, ctx);
	}

	afterStep(_step: IRStep, _index: number, ctx: ActorCtx): Promise<void> {
		return new Promise<void>((resolve) => {
			this.proceedResolve = resolve;
			ctx.signal.addEventListener('abort', () => resolve(), { once: true });
		});
	}

	private yieldAction(
		step: IRStep,
		el: Element | null,
		action: Interaction | null,
		ctx: ActorCtx,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			const marker = action && el ? step.id : null;
			if (marker && el) el.setAttribute(MARKER, marker);
			const finish = (): void => {
				if (el) el.removeAttribute(MARKER);
				this.pending = null;
				resolve();
			};
			this.actedResolve = finish;
			ctx.signal.addEventListener('abort', finish, { once: true });
			this.pending = { stepId: step.id, action, marker };
			if (action) ctx.markActed();
			this.onYield?.(this.pending);
		});
	}
}
