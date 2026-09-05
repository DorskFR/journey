import { parseTarget } from '../core/target.js';
import type { Locator, Target, TargetPath } from '../core/types.js';
import type { Params } from './text.js';

export type ResolveResult =
	| { el: Element; error?: undefined }
	| { el?: undefined; error: 'notfound' }
	| { el?: undefined; error: 'ambiguous'; count: number };

const INPUT_ROLES: Record<string, string> = {
	checkbox: 'checkbox',
	radio: 'radio',
	submit: 'button',
	button: 'button',
	reset: 'button',
	image: 'button',
	search: 'searchbox',
	range: 'slider',
	number: 'spinbutton',
};

const TAG_ROLES: Record<string, string> = {
	button: 'button',
	select: 'combobox',
	textarea: 'textbox',
	h1: 'heading',
	h2: 'heading',
	h3: 'heading',
	h4: 'heading',
	h5: 'heading',
	h6: 'heading',
	nav: 'navigation',
	main: 'main',
	dialog: 'dialog',
	option: 'option',
	li: 'listitem',
	ul: 'list',
	ol: 'list',
	table: 'table',
	img: 'img',
	summary: 'button',
	details: 'group',
};

const HIDDEN_INPUT_TYPES = new Set(['hidden']);

export function describeTarget(target: Target): string {
	return typeof target === 'string' ? target : JSON.stringify(target);
}

function collapse(text: string | null | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Pragmatic subset of the ARIA role computation: the explicit role attribute,
 * otherwise the implicit role of common HTML elements. Not full ARIA.
 */
export function computedRole(el: Element): string | null {
	const explicit = el.getAttribute('role');
	if (explicit) return explicit.trim().split(/\s+/)[0] ?? null;
	const tag = el.tagName.toLowerCase();
	if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
	if (tag === 'input') {
		const type = (el.getAttribute('type') ?? 'text').toLowerCase();
		if (HIDDEN_INPUT_TYPES.has(type)) return null;
		return INPUT_ROLES[type] ?? 'textbox';
	}
	return TAG_ROLES[tag] ?? null;
}

function labelsOf(el: Element): string[] {
	const labels = (el as HTMLInputElement).labels;
	if (!labels) return [];
	return Array.from(labels, (label) => collapse(label.textContent));
}

/**
 * Pragmatic subset of the accessible name computation: aria-labelledby,
 * aria-label, associated label, alt, title, then text content. Not full accname.
 */
export function accessibleName(el: Element): string {
	const labelledBy = el.getAttribute('aria-labelledby');
	if (labelledBy) {
		const text = labelledBy
			.split(/\s+/)
			.map((id) => collapse(el.ownerDocument.getElementById(id)?.textContent))
			.filter((t) => t !== '')
			.join(' ');
		if (text !== '') return text;
	}
	const ariaLabel = el.getAttribute('aria-label');
	if (ariaLabel && collapse(ariaLabel) !== '') return collapse(ariaLabel);
	const label = labelsOf(el).find((t) => t !== '');
	if (label !== undefined) return label;
	if (el.tagName.toLowerCase() === 'img') {
		const alt = el.getAttribute('alt');
		if (alt !== null && collapse(alt) !== '') return collapse(alt);
	}
	const title = el.getAttribute('title');
	if (title && collapse(title) !== '') return collapse(title);
	return collapse(el.textContent);
}

export function isVisible(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	return getComputedStyle(el).visibility !== 'hidden';
}

function outermost(els: Element[]): Element[] {
	return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}

function unique(els: Element[]): Element[] {
	return Array.from(new Set(els));
}

function attr(name: string, value: string): string {
	return `[${name}="${CSS.escape(value)}"]`;
}

export function resolvePath(path: TargetPath, params: Params, root: ParentNode): Element[] {
	const { segments } = parseTarget(path);
	let scopes: ParentNode[] = [root];
	for (const segment of segments) {
		const key = segment.param !== undefined ? params[segment.param] : segment.key;
		if (segment.param !== undefined && key === undefined) {
			throw new Error(`Unresolved param "${segment.param}" in target "${path}"`);
		}
		const selector = attr('data-journey', segment.name);
		scopes = unique(
			scopes.flatMap((scope) => {
				let els = Array.from(scope.querySelectorAll(selector));
				if (key !== undefined) {
					els = els.filter((el) => el.getAttribute('data-journey-key') === key);
				}
				return outermost(els);
			}),
		);
	}
	return scopes as Element[];
}

function labelMatches(el: Element, label: string): boolean {
	const ariaLabel = el.getAttribute('aria-label');
	if (ariaLabel !== null && collapse(ariaLabel) === label) return true;
	return labelsOf(el).includes(label);
}

function textMatches(el: Element, text: string): boolean {
	if (collapse(el.textContent) !== text) return false;
	return !Array.from(el.children).some((child) => collapse(child.textContent) === text);
}

export function resolveLocator(locator: Locator, params: Params, root: ParentNode): Element[] {
	const scopes: ParentNode[] =
		locator.within !== undefined ? resolvePath(locator.within, params, root) : [root];
	const query = (selector: string): Element[] =>
		unique(scopes.flatMap((scope) => Array.from(scope.querySelectorAll(selector))));
	let els: Element[] | null = null;
	const narrow = (list: Element[]): void => {
		els = els === null ? list : els.filter((el) => list.includes(el));
	};
	if (locator.testid !== undefined) narrow(query(attr('data-testid', locator.testid)));
	if (locator.css !== undefined) narrow(query(locator.css));
	if (locator.label !== undefined) {
		const label = collapse(locator.label);
		narrow(
			query('input,select,textarea,button,output,meter,progress').filter((el) =>
				labelMatches(el, label),
			),
		);
	}
	if (locator.role !== undefined || locator.name !== undefined) {
		const name = locator.name === undefined ? undefined : collapse(locator.name);
		narrow(
			query('*').filter((el) => {
				const role = computedRole(el);
				if (role === null) return false;
				if (locator.role !== undefined && role !== locator.role) return false;
				return name === undefined || accessibleName(el) === name;
			}),
		);
	}
	if (locator.text !== undefined) {
		const text = collapse(locator.text);
		narrow(query('*').filter((el) => textMatches(el, text)));
	}
	return els ?? [];
}

export function resolveAll(
	target: Target,
	params: Params = {},
	root: ParentNode = document,
): Element[] {
	if (typeof target === 'string') return resolvePath(target, params, root).filter(isVisible);
	const visible = resolveLocator(target, params, root).filter(isVisible);
	if (target.nth === undefined) return visible;
	const picked = visible[target.nth];
	return picked === undefined ? [] : [picked];
}

export function resolveOne(
	target: Target,
	params: Params = {},
	root: ParentNode = document,
): ResolveResult {
	const matches = resolveAll(target, params, root);
	if (matches.length === 1) return { el: matches[0] as Element };
	if (matches.length === 0) return { error: 'notfound' };
	return { error: 'ambiguous', count: matches.length };
}
