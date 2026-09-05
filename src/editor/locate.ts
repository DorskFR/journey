import type { Locator, Target, TargetPath } from '../core/types.js';
import { collapse, runtime } from './runtime.js';

export type Health = 'stable' | 'fallback' | 'fragile';

export interface Located {
	el: Element;
	target: Target;
	health: Health;
}

const INTERACTIVE =
	'button,a,input,select,textarea,[role],[data-journey],[contenteditable],[tabindex]';

export function interactiveAncestor(el: Element): Element {
	return el.closest(INTERACTIVE) ?? el;
}

function chain(el: Element): Element[] {
	const els: Element[] = [];
	let cur: Element | null = el.closest('[data-journey]');
	while (cur) {
		els.unshift(cur);
		cur = cur.parentElement?.closest('[data-journey]') ?? null;
	}
	return els;
}

function segment(el: Element, keyed: boolean): string {
	const name = el.getAttribute('data-journey') ?? '';
	const key = el.getAttribute('data-journey-key');
	return keyed && key !== null && key !== '' ? `${name}[${key}]` : name;
}

function pathOf(els: Element[], keyedFrom: number): TargetPath {
	return els.map((el, i) => segment(el, i >= keyedFrom)).join('/');
}

function matches(target: Target, el: Element): boolean {
	try {
		return runtime().resolveOne(target).el === el;
	} catch {
		return false;
	}
}

function scoped(els: Element[], el: Element): TargetPath | null {
	for (let from = els.length; from >= 0; from -= 1) {
		const path = pathOf(els, from);
		if (matches(path, el)) return path;
	}
	return null;
}

export function journeyPath(el: Element): TargetPath | null {
	const els = chain(el);
	if (els.length === 0 || els[els.length - 1] !== el) return null;
	return scoped(els, el);
}

function containerPath(el: Element): TargetPath | null {
	const container = el.parentElement?.closest('[data-journey]');
	if (!container) return null;
	const els = chain(container);
	const path = journeyPath(container) ?? pathOf(els, 0);
	try {
		return runtime().resolvePath(path, {}, document).length > 0 ? path : null;
	} catch {
		return null;
	}
}

function labelOf(el: Element): string | null {
	const aria = collapse(el.getAttribute('aria-label'));
	if (aria !== '') return aria;
	const labels = (el as HTMLInputElement).labels;
	if (!labels) return null;
	const text = Array.from(labels, (label) => collapse(label.textContent)).find((t) => t !== '');
	return text ?? null;
}

function candidates(el: Element): Locator[] {
	const { computedRole, accessibleName } = runtime();
	const list: Locator[] = [];
	const testid = el.getAttribute('data-testid');
	if (testid) list.push({ testid });
	const label = labelOf(el);
	if (label !== null) list.push({ label });
	const role = computedRole(el);
	const name = accessibleName(el);
	if (role !== null && name !== '') list.push({ role, name });
	const text = collapse(el.textContent);
	if (text !== '' && text.length <= 60) list.push({ text });
	return list;
}

function fallback(el: Element): Locator | null {
	const within = containerPath(el);
	for (const candidate of candidates(el)) {
		if (matches(candidate, el)) return candidate;
		if (within !== null) {
			const inner = { ...candidate, within };
			if (matches(inner, el)) return inner;
		}
	}
	return null;
}

function nthOfType(el: Element): number {
	let n = 1;
	let prev = el.previousElementSibling;
	while (prev) {
		if (prev.tagName === el.tagName) n += 1;
		prev = prev.previousElementSibling;
	}
	return n;
}

function fragile(el: Element): Target {
	let anchor: Element | null = el.parentElement;
	while (anchor && anchor !== document.body && !anchor.id && !anchor.hasAttribute('data-journey')) {
		anchor = anchor.parentElement;
	}
	const stop = anchor ?? document.body;
	const segments: string[] = [];
	let cur: Element | null = el;
	while (cur && cur !== stop) {
		segments.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nthOfType(cur)})`);
		cur = cur.parentElement;
	}
	if (segments.length === 0) return { css: el.tagName.toLowerCase() };
	const tail = segments.join(' > ');
	if (stop.id) return { css: `#${CSS.escape(stop.id)} > ${tail}` };
	if (stop !== document.body && stop.hasAttribute('data-journey')) {
		const within = journeyPath(stop) ?? pathOf(chain(stop), 0);
		return { css: `:scope > ${tail}`, within };
	}
	return { css: `body > ${tail}` };
}

export function locate(origin: Element): Located {
	const el = interactiveAncestor(origin);
	const path = journeyPath(el);
	if (path !== null) return { el, target: path, health: 'stable' };
	const locator = fallback(el);
	if (locator !== null) return { el, target: locator, health: 'fallback' };
	return { el, target: fragile(el), health: 'fragile' };
}
