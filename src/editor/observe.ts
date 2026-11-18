import type { Interaction } from '../core/types.js';
import { SENSITIVE_NAME } from '../core/validate.js';
import { onHistoryChange } from '../runtime/route.js';
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
const CLICK_ROUTE_WINDOW = 500;

function inputType(el: Element): string {
	return (el.getAttribute('type') ?? 'text').toLowerCase();
}

function isElement(node: unknown): node is Element {
	return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}

function isToggle(el: Element): el is HTMLInputElement {
	return el.localName === 'input' && (inputType(el) === 'checkbox' || inputType(el) === 'radio');
}

export function isTextControl(el: Element): boolean {
	if (el.localName === 'textarea') return true;
	if (el.localName === 'input') return !NON_TEXT_TYPES.has(inputType(el));
	return (el as HTMLElement).isContentEditable === true;
}

function controlValue(el: Element): string {
	if (el.localName === 'input' || el.localName === 'textarea') {
		return (el as HTMLInputElement).value;
	}
	return el.textContent ?? '';
}

export function isSensitive(el: Element): boolean {
	if (el.localName === 'input' && inputType(el) === 'password') return true;
	const autocomplete = el.getAttribute('autocomplete') ?? '';
	if (autocomplete.includes('one-time-code') || autocomplete.includes('cc-')) return true;
	return [el.getAttribute('name'), el.getAttribute('id'), autocomplete].some(
		(v) => v !== null && SENSITIVE_NAME.test(v),
	);
}

export function paramName(el: Element): string {
	return (
		el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('data-journey') || 'secret'
	);
}

function skipsClick(el: Element): boolean {
	if (el.localName === 'label') {
		const control = (el as HTMLLabelElement).control;
		return control !== null && isToggle(control);
	}
	if (el.localName === 'option' || el.localName === 'select') return true;
	return isToggle(el) || isTextControl(el);
}

export function createObserver<P>(options: ObserverOptions<P>): Observer {
	let pending: { el: Element; prepared: P } | null = null;
	let lastClick = 0;
	let lastRoute = '';
	let pendingRoute: string | undefined;
	let active = false;
	let unhook: (() => void) | null = null;
	const docs = new Set<Document>();

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

	const originOf = (event: Event): Element | null => {
		const first = event.composedPath()[0] ?? event.target;
		return isElement(first) ? first : null;
	};

	const targetOf = (event: Event): Element | null => {
		if (options.ignore(event)) return null;
		return originOf(event);
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

	const changed = (el: Element): void => {
		if (el.localName === 'select') {
			flush();
			const value = (el as HTMLSelectElement).value;
			emit({ el, prepared: options.prepare(el), do: { kind: 'select', value } });
			return;
		}
		if (isToggle(el)) {
			flush();
			emit({ el, prepared: options.prepare(el), do: { kind: 'check', checked: el.checked } });
			return;
		}
		if (pending && pending.el === el) flush();
	};

	const onInput = (event: Event): void => {
		const el = targetOf(event);
		if (!el) return;
		if (el !== event.target && (el.localName === 'select' || isToggle(el))) {
			changed(el);
			return;
		}
		if (!isTextControl(el)) return;
		if (pending && pending.el !== el) flush();
		if (!pending) pending = { el, prepared: options.prepare(el) };
	};

	const onChange = (event: Event): void => {
		const el = targetOf(event);
		if (el) changed(el);
	};

	const onFocusOut = (event: Event): void => {
		if (pending && pending.el === originOf(event)) flush();
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

	const frameDoc = (el: Element): Document | null => {
		try {
			return (el as HTMLIFrameElement).contentDocument;
		} catch {
			return null;
		}
	};

	const onFrameLoad = (event: Event): void => {
		const el = originOf(event);
		if (el?.localName !== 'iframe') return;
		const doc = frameDoc(el);
		if (doc) listen(doc);
	};

	const listeners: Array<[string, (event: Event) => void]> = [
		['click', onClick],
		['dblclick', onDblclick],
		['input', onInput],
		['change', onChange],
		['focusout', onFocusOut],
		['keydown', onKeydown],
		['load', onFrameLoad],
	];

	const listen = (doc: Document): void => {
		if (docs.has(doc)) return;
		docs.add(doc);
		for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);
		for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
			const inner = frameDoc(frame);
			if (inner) listen(inner);
		}
	};

	return {
		start() {
			if (active) return;
			active = true;
			lastRoute = currentRoute();
			listen(document);
			window.addEventListener('popstate', onNavigation);
			window.addEventListener('hashchange', onNavigation);
			unhook = onHistoryChange(onNavigation);
		},
		stop() {
			if (!active) return;
			flush();
			active = false;
			pendingRoute = undefined;
			for (const doc of docs) {
				for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
			}
			docs.clear();
			window.removeEventListener('popstate', onNavigation);
			window.removeEventListener('hashchange', onNavigation);
			unhook?.();
			unhook = null;
		},
		flush,
		attachRoute(route) {
			pendingRoute = route;
			lastRoute = route;
		},
	};
}
