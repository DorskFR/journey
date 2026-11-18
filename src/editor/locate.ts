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

export function isInteractive(el: Element): boolean {
	return el.closest(INTERACTIVE) !== null;
}

interface Link {
	el: Element;
	into: boolean;
}

function hostOf(el: Element): Element | null {
	const root = el.getRootNode();
	if ('host' in root && isElement(root.host)) return root.host;
	if (root === document || root.nodeType !== Node.DOCUMENT_NODE) return null;
	try {
		return (root as Document).defaultView?.frameElement ?? null;
	} catch {
		return null;
	}
}

function isElement(node: unknown): node is Element {
	return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}

function chain(el: Element): Link[] {
	const links: Link[] = [];
	let cur: Element | null = el;
	let crossed = false;
	while (cur) {
		if (cur.hasAttribute('data-journey')) links.unshift({ el: cur, into: crossed });
		else if (crossed) break;
		crossed = false;
		if (cur.parentElement) cur = cur.parentElement;
		else {
			cur = hostOf(cur);
			crossed = true;
		}
	}
	return links;
}

export type PathStyle = 'key' | 'index';

export interface LocateOptions {
	prefer?: PathStyle;
}

function resolves(path: TargetPath): Element[] {
	try {
		return runtime().resolvePath(path, {}, document);
	} catch {
		return [];
	}
}

function indexed(prefix: TargetPath, el: Element, name: string): string {
	const found = resolves(prefix + name);
	if (found.length < 2) return name;
	for (let i = 0; i < found.length; i += 1) {
		const seg = `${name}[#${i}]`;
		if (resolves(prefix + seg).includes(el)) return seg;
	}
	return name;
}

function segment(el: Element, style: PathStyle | null, prefix: TargetPath): string {
	const name = el.getAttribute('data-journey') ?? '';
	if (style === 'index') return indexed(prefix, el, name);
	const key = el.getAttribute('data-journey-key');
	return style === 'key' && key !== null && key !== '' ? `${name}[${key}]` : name;
}

function pathOf(links: Link[], styledFrom: number, style: PathStyle = 'key'): TargetPath {
	let path = '';
	links.forEach((link, i) => {
		const sep = i === 0 ? '' : links[i - 1]?.into ? '>>' : '/';
		path += sep + segment(link.el, i >= styledFrom ? style : null, path + sep);
	});
	return path;
}

function matches(target: Target, el: Element): boolean {
	try {
		return runtime().resolveOne(target).el === el;
	} catch {
		return false;
	}
}

function scoped(links: Link[], el: Element, prefer: PathStyle): TargetPath | null {
	const styles: PathStyle[] = prefer === 'index' ? ['index', 'key'] : ['key', 'index'];
	for (const style of styles) {
		for (let i = 0; i <= links.length; i += 1) {
			const from = style === 'key' ? links.length - i : i;
			const path = pathOf(links, from, style);
			if (matches(path, el)) return path;
		}
	}
	return null;
}

export function journeyPath(el: Element, options: LocateOptions = {}): TargetPath | null {
	const links = chain(el);
	if (links.length === 0 || links[links.length - 1]?.el !== el) return null;
	return scoped(links, el, options.prefer ?? 'key');
}

function reachable(el: Element): TargetPath | null {
	const path = journeyPath(el) ?? pathOf(chain(el), 0);
	if (path === '') return null;
	return resolves(path).length > 0 ? path : null;
}

function hostScope(el: Element): TargetPath | null {
	const host = hostOf(el);
	if (!host?.hasAttribute('data-journey')) return null;
	const path = reachable(host);
	return path === null ? null : `${path}>>`;
}

function containerPath(el: Element): TargetPath | null {
	const container = el.parentElement?.closest('[data-journey]');
	if (!container) return hostScope(el);
	return reachable(container);
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
	const root = el.getRootNode();
	const top = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).body : null;
	const scope = root === document ? undefined : (hostScope(el) ?? undefined);
	const within = scope === undefined ? {} : { within: scope };
	let anchor: Element | null = el.parentElement;
	while (anchor && anchor !== top && !anchor.id && !anchor.hasAttribute('data-journey')) {
		anchor = anchor.parentElement;
	}
	const segments: string[] = [];
	let cur: Element | null = el;
	while (cur && cur !== anchor && cur !== top) {
		segments.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nthOfType(cur)})`);
		cur = cur.parentElement;
	}
	if (segments.length === 0) return { css: el.tagName.toLowerCase(), ...within };
	const tail = segments.join(' > ');
	if (anchor?.id) return { css: `#${CSS.escape(anchor.id)} > ${tail}`, ...within };
	if (anchor && anchor !== top && anchor.hasAttribute('data-journey')) {
		const scopePath = journeyPath(anchor) ?? pathOf(chain(anchor), 0);
		return { css: `:scope > ${tail}`, within: scopePath };
	}
	return { css: anchor ? `body > ${tail}` : tail, ...within };
}

export function locate(origin: Element, options: LocateOptions = {}): Located {
	const el = interactiveAncestor(origin);
	const path = journeyPath(el, options);
	if (path !== null) return { el, target: path, health: 'stable' };
	const locator = fallback(el);
	if (locator !== null) return { el, target: locator, health: 'fallback' };
	return { el, target: fragile(el), health: 'fragile' };
}
