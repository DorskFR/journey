import type { Overlay } from '../runtime/overlay.js';
import { interactiveAncestor } from './locate.js';

const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

function frameDocument(el: Element): Document | null {
	if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
	try {
		return (el as HTMLIFrameElement).contentDocument;
	} catch {
		return null;
	}
}

function frameDocuments(doc: Document): Document[] {
	return [...doc.querySelectorAll('iframe,frame')].flatMap((frame) => {
		const inner = frameDocument(frame);
		return inner ? [inner, ...frameDocuments(inner)] : [];
	});
}

export function pickElement(overlay: Overlay): Promise<Element | null> {
	return new Promise((resolve) => {
		const spot = overlay.parts.spot;
		const controller = new AbortController();
		const options = { capture: true, signal: controller.signal };
		const listening = new Set<Document>();
		let hovered: Element | null = null;
		const inside = (event: Event): boolean => event.composedPath().includes(overlay.host);
		const located = (event: Event): Element | null => {
			const el = event.composedPath()[0] as Partial<Node> | undefined;
			return el?.nodeType === Node.ELEMENT_NODE ? interactiveAncestor(el as Element) : null;
		};
		const finish = (el: Element | null): void => {
			controller.abort();
			spot.hidden = true;
			spot.classList.remove('doc');
			overlay.track(null);
			resolve(el);
		};
		const listen = (doc: Document): void => {
			if (listening.has(doc)) return;
			listening.add(doc);
			doc.addEventListener(
				'pointerover',
				(event) => {
					if (inside(event)) return;
					const el = located(event);
					if (!el || el === hovered) return;
					const inner = frameDocument(el);
					if (inner) {
						listen(inner);
						return;
					}
					hovered = el;
					overlay.track(el, { scroll: false });
				},
				options,
			);
			for (const type of BLOCKED) {
				doc.addEventListener(
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
			doc.addEventListener(
				'keydown',
				(event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					event.stopImmediatePropagation();
					finish(null);
				},
				options,
			);
		};
		for (const doc of [document, ...frameDocuments(document)]) listen(doc);
		spot.classList.add('doc');
		spot.hidden = false;
		overlay.track(null);
	});
}
