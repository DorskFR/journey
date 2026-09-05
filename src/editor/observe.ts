import type { Interaction } from '../core/types.js';
import { interactiveAncestor } from './locate.js';
import { currentRoute } from './runtime.js';

export interface Observed<P> {
	el: Element | null;
	prepared: P | null;
	do: Interaction;
	route?: string;
}

export interface ObserverOptions<P> {
	ignore(event: Event): boolean;
	prepare(el: Element): P;
	emit(item: Observed<P>): void;
}

export interface Observer {
	start(): void;
	stop(): void;
	flush(): void;
	attachRoute(route: string): void;
}

const PRESS_KEYS = new Set([
	'Enter',
	'Escape',
	'Tab',
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
]);
const NON_TEXT_TYPES = new Set([
	'checkbox',
	'radio',
	'button',
	'submit',
	'reset',
	'file',
	'image',
	'range',
	'color',
	'hidden',
]);
const SENSITIVE = /pass|token|secret|otp|card|cvc|ssn/i;
const CLICK_ROUTE_WINDOW = 500;

function inputType(el: Element): string {
	return (el.getAttribute('type') ?? 'text').toLowerCase();
}

function isToggle(el: Element): el is HTMLInputElement {
	return (
		el instanceof HTMLInputElement && (inputType(el) === 'checkbox' || inputType(el) === 'radio')
	);
}

export function isTextControl(el: Element): boolean {
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement) return !NON_TEXT_TYPES.has(inputType(el));
	return el instanceof HTMLElement && el.isContentEditable;
}

function controlValue(el: Element): string {
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
	return el.textContent ?? '';
}

export function isSensitive(el: Element): boolean {
	if (el instanceof HTMLInputElement && inputType(el) === 'password') return true;
	const autocomplete = el.getAttribute('autocomplete') ?? '';
	if (autocomplete.includes('one-time-code') || autocomplete.includes('cc-')) return true;
	return [el.getAttribute('name'), el.getAttribute('id'), autocomplete].some(
		(v) => v !== null && SENSITIVE.test(v),
	);
}

export function paramName(el: Element): string {
	return (
		el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('data-journey') || 'secret'
	);
}

function skipsClick(el: Element): boolean {
	if (el instanceof HTMLLabelElement) return el.control !== null && isToggle(el.control);
	if (el instanceof HTMLOptionElement || el instanceof HTMLSelectElement) return true;
	return isToggle(el) || isTextControl(el);
}

export function createObserver<P>(options: ObserverOptions<P>): Observer {
	let pending: { el: Element; prepared: P } | null = null;
	let lastClick = 0;
	let lastRoute = '';
	let pendingRoute: string | undefined;
	let active = false;
	let originals: { pushState: History['pushState']; replaceState: History['replaceState'] } | null =
		null;

	const emit = (item: Observed<P>): void => {
		if (item.route === undefined && pendingRoute !== undefined) item.route = pendingRoute;
		pendingRoute = undefined;
		options.emit(item);
	};

	const flush = (): void => {
		if (!pending) return;
		const { el, prepared } = pending;
		pending = null;
		const action: Interaction = isSensitive(el)
			? { kind: 'fill', value: { $param: `var.${paramName(el)}` }, mask: true }
			: { kind: 'fill', value: controlValue(el) };
		emit({ el, prepared, do: action });
	};

	const targetOf = (event: Event): Element | null => {
		if (options.ignore(event)) return null;
		return event.target instanceof Element ? event.target : null;
	};

	const onClick = (event: Event): void => {
		const origin = targetOf(event);
		if (!origin) return;
		const el = interactiveAncestor(origin);
		if (skipsClick(origin) || skipsClick(el)) return;
		if (pending && pending.el !== el) flush();
		lastClick = Date.now();
		emit({ el, prepared: options.prepare(el), do: { kind: 'click' } });
	};

	const onDblclick = (event: Event): void => {
		const origin = targetOf(event);
		if (!origin) return;
		const el = interactiveAncestor(origin);
		if (skipsClick(origin) || skipsClick(el)) return;
		emit({ el, prepared: options.prepare(el), do: { kind: 'dblclick' } });
	};

	const onInput = (event: Event): void => {
		const el = targetOf(event);
		if (!el || !isTextControl(el)) return;
		if (pending && pending.el !== el) flush();
		if (!pending) pending = { el, prepared: options.prepare(el) };
	};

	const onChange = (event: Event): void => {
		const el = targetOf(event);
		if (!el) return;
		if (el instanceof HTMLSelectElement) {
			flush();
			emit({ el, prepared: options.prepare(el), do: { kind: 'select', value: el.value } });
			return;
		}
		if (isToggle(el)) {
			flush();
			emit({ el, prepared: options.prepare(el), do: { kind: 'check', checked: el.checked } });
			return;
		}
		if (pending && pending.el === el) flush();
	};

	const onFocusOut = (event: Event): void => {
		if (pending && pending.el === event.target) flush();
	};

	const onKeydown = (event: Event): void => {
		const key = (event as KeyboardEvent).key;
		if (!PRESS_KEYS.has(key)) return;
		const origin = targetOf(event);
		if (!origin) return;
		if (key === 'Enter' || key === 'Tab') flush();
		const el = interactiveAncestor(origin);
		emit({ el, prepared: options.prepare(el), do: { kind: 'press', key } });
	};

	const onNavigation = (): void => {
		const route = currentRoute();
		if (route === lastRoute) return;
		lastRoute = route;
		if (Date.now() - lastClick < CLICK_ROUTE_WINDOW) {
			pendingRoute = route;
			return;
		}
		emit({ el: null, prepared: null, do: { kind: 'none' }, route });
	};

	const listeners: Array<[string, (event: Event) => void]> = [
		['click', onClick],
		['dblclick', onDblclick],
		['input', onInput],
		['change', onChange],
		['focusout', onFocusOut],
		['keydown', onKeydown],
	];

	return {
		start() {
			if (active) return;
			active = true;
			lastRoute = currentRoute();
			for (const [type, fn] of listeners) document.addEventListener(type, fn, true);
			window.addEventListener('popstate', onNavigation);
			window.addEventListener('hashchange', onNavigation);
			const { pushState, replaceState } = history;
			originals = { pushState, replaceState };
			history.pushState = function (this: History, ...args) {
				pushState.apply(this, args);
				onNavigation();
			};
			history.replaceState = function (this: History, ...args) {
				replaceState.apply(this, args);
				onNavigation();
			};
		},
		stop() {
			if (!active) return;
			flush();
			active = false;
			pendingRoute = undefined;
			for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
			window.removeEventListener('popstate', onNavigation);
			window.removeEventListener('hashchange', onNavigation);
			if (originals) {
				history.pushState = originals.pushState;
				history.replaceState = originals.replaceState;
				originals = null;
			}
		},
		flush,
		attachRoute(route) {
			pendingRoute = route;
			lastRoute = route;
		},
	};
}
