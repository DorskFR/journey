import type { Overlay } from '../runtime/overlay.js';
import { interactiveAncestor } from './locate.js';

const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

export function pickElement(overlay: Overlay): Promise<Element | null> {
	return new Promise((resolve) => {
		const spot = overlay.parts.spot;
		const controller = new AbortController();
		const options = { capture: true, signal: controller.signal };
		let hovered: Element | null = null;
		const inside = (event: Event): boolean => event.composedPath().includes(overlay.host);
		const located = (event: Event): Element | null =>
			event.target instanceof Element ? interactiveAncestor(event.target) : null;
		const finish = (el: Element | null): void => {
			controller.abort();
			spot.hidden = true;
			spot.classList.remove('doc');
			overlay.track(null);
			resolve(el);
		};
		document.addEventListener(
			'pointerover',
			(event) => {
				if (inside(event)) return;
				const el = located(event);
				if (!el || el === hovered) return;
				hovered = el;
				overlay.track(el, { scroll: false });
			},
			options,
		);
		for (const type of BLOCKED) {
			document.addEventListener(
				type,
				(event) => {
					if (inside(event)) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					if (type === 'click') finish(located(event) ?? hovered);
				},
				options,
			);
		}
		document.addEventListener(
			'keydown',
			(event) => {
				if (event.key !== 'Escape') return;
				event.preventDefault();
				event.stopImmediatePropagation();
				finish(null);
			},
			options,
		);
		spot.classList.add('doc');
		spot.hidden = false;
		overlay.track(null);
	});
}
