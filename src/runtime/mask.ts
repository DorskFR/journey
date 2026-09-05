import type { TargetPath } from '../core/types.js';
import { resolvePath } from './resolve.js';
import type { Params } from './text.js';

const STYLE_ID = 'journey-mask-style';
const ATTR = 'data-journey-mask';

export function installMaskStyle(): void {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const parent = document.head ?? document.documentElement;
	if (!parent) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `[${ATTR}]{filter:blur(8px)!important}`;
	parent.append(style);
}

export class Masker {
	private readonly applied = new Set<Element>();

	apply(paths: TargetPath[], params: Params): void {
		installMaskStyle();
		for (const path of paths) {
			let matches: Element[] = [];
			try {
				matches = resolvePath(path, params, document);
			} catch {
				matches = [];
			}
			for (const el of matches) {
				if (el.hasAttribute(ATTR)) continue;
				el.setAttribute(ATTR, '');
				this.applied.add(el);
			}
		}
	}

	clear(): void {
		for (const el of this.applied) el.removeAttribute(ATTR);
		this.applied.clear();
	}
}
