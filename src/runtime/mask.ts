import type { Target, TargetPath } from '../core/types.js';
import { resolveAll, resolvePath } from './resolve.js';
import type { Params } from './text.js';

const STYLE_ID = 'journey-mask-style';
const ATTR = 'data-journey-mask';
const WATCHED = [
	ATTR,
	'data-journey',
	'data-journey-key',
	'data-testid',
	'id',
	'role',
	'aria-label',
	'hidden',
	'open',
];

export function installMaskStyle(): void {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const parent = document.head ?? document.documentElement;
	if (!parent) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `[${ATTR}]{filter:blur(8px)!important}`;
	parent.append(style);
}

interface Rule {
	target: Target;
	params: Params;
}

function matches(rule: Rule): Element[] {
	try {
		return typeof rule.target === 'string'
			? resolvePath(rule.target, rule.params, document)
			: resolveAll(rule.target, rule.params, document);
	} catch {
		return [];
	}
}

// Mutation callbacks run before the next paint, so new or re-rendered matches are masked in every frame.
export class Masker {
	private readonly applied = new Set<Element>();
	private readonly pinned = new Set<Element>();
	private readonly kept: Rule[] = [];
	private paths: Rule[] = [];
	private observer: MutationObserver | null = null;

	apply(paths: TargetPath[], params: Params): void {
		this.paths = paths.map((target) => ({ target, params }));
		installMaskStyle();
		this.refresh();
	}

	keep(target: Target, params: Params, el: Element | null): void {
		this.kept.push({ target, params });
		if (el) this.pinned.add(el);
		this.refresh();
	}

	refresh(): void {
		if (typeof document === 'undefined') return;
		if (this.pinned.size === 0 && this.paths.length === 0 && this.kept.length === 0) return;
		installMaskStyle();
		const els = new Set(this.pinned);
		for (const rule of [...this.paths, ...this.kept]) for (const el of matches(rule)) els.add(el);
		for (const el of els) {
			if (el.hasAttribute(ATTR)) continue;
			el.setAttribute(ATTR, '');
			this.applied.add(el);
		}
		this.watch();
	}

	private watch(): void {
		if (this.observer || typeof MutationObserver === 'undefined') return;
		this.observer = new MutationObserver(() => this.refresh());
		this.observer.observe(document.documentElement, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: WATCHED,
		});
	}

	clear(): void {
		this.observer?.disconnect();
		this.observer = null;
		for (const el of this.applied) el.removeAttribute(ATTR);
		this.applied.clear();
		this.pinned.clear();
		this.kept.length = 0;
		this.paths = [];
	}
}
