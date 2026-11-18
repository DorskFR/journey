import { endsInside, formatTarget, parseTarget } from '../core/target.js';
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

const NAME_FROM_CONTENT_ROLES = new Set([
	'button',
	'cell',
	'checkbox',
	'columnheader',
	'gridcell',
	'heading',
	'link',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'radio',
	'row',
	'rowheader',
	'switch',
	'tab',
	'tooltip',
	'treeitem',
]);

const HIDDEN_INPUT_TYPES = new Set(['hidden']);

export function describeTarget(target: Target): string {
	return typeof target === 'string' ? target : JSON.stringify(target);
}

export function ambiguityHint(target: Target): string {
	if (typeof target !== 'string') return '';
	let last: ReturnType<typeof parseTarget>['segments'][number] | undefined;
	try {
		last = parseTarget(target).segments.at(-1);
	} catch {
		return '';
	}
	if (last === undefined) return '';
	if (last.key !== undefined || last.param !== undefined || last.index !== undefined) return '';
	return ` (add a key or an index, e.g. "${formatTarget({ segments: [{ ...last, index: 0 }] })}")`;
}

function idScope(el: Element): Document | ShadowRoot {
	const root = el.getRootNode() as Partial<Document | ShadowRoot>;
	return typeof root.getElementById === 'function'
		? (root as Document | ShadowRoot)
		: el.ownerDocument;
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
 * aria-label, associated label, alt, then text content for roles named from
 * content, and title as the last fallback. Not full accname.
 */
export function accessibleName(el: Element): string {
	const labelledBy = el.getAttribute('aria-labelledby');
	if (labelledBy) {
		const text = labelledBy
			.split(/\s+/)
			.map((id) => collapse(idScope(el).getElementById(id)?.textContent))
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
	const role = computedRole(el);
	const content = collapse(el.textContent);
	if (role !== null && NAME_FROM_CONTENT_ROLES.has(role) && content !== '') return content;
	const title = el.getAttribute('title');
	if (title && collapse(title) !== '') return collapse(title);
	return content;
}

export function isVisible(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return false;
	if (typeof el.checkVisibility === 'function')
		return el.checkVisibility({ visibilityProperty: true });
	const view = el.ownerDocument.defaultView ?? window;
	return view.getComputedStyle(el).visibility !== 'hidden';
}

// Design systems hide the native control and draw its label instead.
function labelVisible(el: Element): boolean {
	const labels = (el as HTMLInputElement).labels;
	return labels ? Array.from(labels).some(isVisible) : false;
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

function inside(el: Element): ParentNode | null {
	if (el.shadowRoot) return el.shadowRoot;
	const tag = el.localName;
	if (tag !== 'iframe' && tag !== 'frame') return null;
	try {
		return (el as HTMLIFrameElement).contentDocument;
	} catch {
		return null;
	}
}

function resolveScopes(path: TargetPath, params: Params, root: ParentNode): ParentNode[] {
	const { segments } = parseTarget(path);
	let scopes: ParentNode[] = [root];
	for (const segment of segments) {
		const key = segment.param !== undefined ? params[segment.param] : segment.key;
		if (segment.param !== undefined && key === undefined) {
			throw new Error(`Unresolved param "${segment.param}" in target "${path}"`);
		}
		const selector = attr('data-journey', segment.name);
		let matched = unique(
			scopes.flatMap((scope) => {
				let els = Array.from(scope.querySelectorAll(selector));
				if (key !== undefined) {
					els = els.filter((el) => el.getAttribute('data-journey-key') === key);
				}
				return outermost(els);
			}),
		);
		if (segment.index !== undefined) {
			const visible = matched.filter(isVisible);
			const picked = visible.at(segment.index);
			matched = picked === undefined ? [] : [picked];
		}
		scopes = segment.into
			? matched.flatMap((el) => {
					const inner = inside(el);
					return inner === null ? [] : [inner];
				})
			: matched;
	}
	return scopes;
}

export function resolvePath(path: TargetPath, params: Params, root: ParentNode): Element[] {
	if (endsInside(parseTarget(path))) {
		throw new Error(`Target "${path}" ends with ">>"; only a locator's within may`);
	}
	return resolveScopes(path, params, root) as Element[];
}

function labelMatches(el: Element, label: string): boolean {
	const ariaLabel = el.getAttribute('aria-label');
	if (ariaLabel !== null && collapse(ariaLabel) === label) return true;
	return labelsOf(el).includes(label);
}

// An element whose text does not contain `text` has no descendant that matches.
function textCandidates(scope: ParentNode, text: string): Element[] {
	const out: Element[] = [];
	const visit = (el: Element): void => {
		const own = collapse(el.textContent);
		if (!own.includes(text)) return;
		const children = Array.from(el.children);
		if (own === text && !children.some((child) => collapse(child.textContent) === text)) {
			out.push(el);
		}
		for (const child of children) visit(child);
	};
	for (const child of Array.from(scope.children)) visit(child);
	return out;
}

const ROLE_TAGS = new Map<string, string[]>();
for (const [type, role] of Object.entries(INPUT_ROLES)) {
	ROLE_TAGS.set(role, [...(ROLE_TAGS.get(role) ?? []), `input[type="${type}" i]`]);
}
for (const [tag, role] of Object.entries(TAG_ROLES)) {
	ROLE_TAGS.set(role, [...(ROLE_TAGS.get(role) ?? []), tag]);
}
ROLE_TAGS.set('link', ['a[href]', 'area[href]']);
ROLE_TAGS.set('textbox', [...(ROLE_TAGS.get('textbox') ?? []), 'input']);

// Only the elements computedRole can give a role to, narrowed to `role` when given.
function roleSelector(role: string | undefined): string {
	const tags =
		role === undefined ? [...new Set([...ROLE_TAGS.values()].flat())] : (ROLE_TAGS.get(role) ?? []);
	return ['[role]', ...tags].join(',');
}

export function resolveLocator(locator: Locator, params: Params, root: ParentNode): Element[] {
	const scopes: ParentNode[] =
		locator.within !== undefined ? resolveScopes(locator.within, params, root) : [root];
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
			query(roleSelector(locator.role)).filter((el) => {
				const role = computedRole(el);
				if (role === null) return false;
				if (locator.role !== undefined && role !== locator.role) return false;
				return name === undefined || accessibleName(el) === name;
			}),
		);
	}
	if (locator.text !== undefined) {
		const text = collapse(locator.text);
		narrow(unique(scopes.flatMap((scope) => textCandidates(scope, text))));
	}
	return els ?? [];
}

export interface ResolveOptions {
	/** Count a hidden form control as visible when one of its labels is. */
	labelled?: boolean;
}

export function resolveAll(
	target: Target,
	params: Params = {},
	root: ParentNode = document,
	options: ResolveOptions = {},
): Element[] {
	const shown = options.labelled ? (el: Element) => isVisible(el) || labelVisible(el) : isVisible;
	if (typeof target === 'string') return resolvePath(target, params, root).filter(shown);
	const visible = resolveLocator(target, params, root).filter(shown);
	if (target.nth === undefined) return visible;
	const picked = visible[target.nth];
	return picked === undefined ? [] : [picked];
}

export function resolveOne(
	target: Target,
	params: Params = {},
	root: ParentNode = document,
	options: ResolveOptions = {},
): ResolveResult {
	const matches = resolveAll(target, params, root, options);
	if (matches.length === 1) return { el: matches[0] as Element };
	if (matches.length === 0) return { error: 'notfound' };
	return { error: 'ambiguous', count: matches.length };
}
