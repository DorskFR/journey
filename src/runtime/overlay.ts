export type PartName =
	| 'spot'
	| 'badge'
	| 'card'
	| 'cursor'
	| 'ripple'
	| 'toast'
	| 'caption'
	| 'panel'
	| 'launcher';

export interface Overlay {
	readonly host: HTMLElement;
	readonly root: ShadowRoot;
	readonly parts: Record<PartName, HTMLElement>;
	raise(): void;
	remove(): void;
	target(): DOMRect | null;
	track(el: Element | null, options?: { scroll?: boolean }): void;
	layout(): void;
}

const CSS_TEXT = `
:host{position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;color:#111;font:14px/1.4 system-ui,sans-serif}
*{box-sizing:border-box}
[hidden]{display:none!important}
.spot{position:absolute;border-radius:6px;box-shadow:0 0 0 3px #ffd166,0 0 0 9999px rgba(0,0,0,.55);transition:top .25s,left .25s,width .25s,height .25s}
.spot.doc{box-shadow:0 0 0 3px #ffd166}
.badge{position:absolute;min-width:26px;height:26px;padding:0 8px;border-radius:13px;background:#ffd166;color:#111;font-weight:700;line-height:26px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.card{position:absolute;width:320px;max-width:calc(100vw - 24px);padding:16px;border-radius:8px;background:#fff;color:#111;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:auto}
.card h2{margin:0 0 8px;font-size:16px}
.card p{margin:0 0 12px}
.card .meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:#555}
.card .buttons{display:flex;gap:8px}
.card button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:inherit;cursor:pointer}
.card button.next{background:#ffd166;border-color:#ffd166;font-weight:600}
.caption{position:absolute;max-width:280px;padding:8px 12px;border-radius:6px;background:#fff;color:#111;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.cursor{position:absolute;top:0;left:0;width:24px;height:24px;transition:transform 350ms ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
.ripple{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border:3px solid #ffd166;border-radius:50%;opacity:0}
.ripple.on{animation:journey-ripple .5s ease-out}
@keyframes journey-ripple{0%{transform:scale(1);opacity:1}100%{transform:scale(4);opacity:0}}
.toast{position:fixed;right:16px;bottom:16px;padding:8px 14px;border-radius:6px;background:#111;color:#fff;font-weight:600}
.toast kbd{padding:2px 6px;border:1px solid #888;border-radius:4px;background:#333;font:inherit}
.panel{position:fixed;top:0;right:0;pointer-events:auto}
.launcher{position:fixed;left:16px;bottom:16px;pointer-events:auto;font:inherit}
.launcher button{padding:6px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:inherit;cursor:pointer}
.launcher ul{list-style:none;margin:0 0 8px;padding:8px;background:#fff;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25)}
`;

const CURSOR_SVG =
	'<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 2l16 9-7 1.5L17.5 20l-3 1.5L11 14l-5 5z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';

const PART_NAMES: PartName[] = [
	'spot',
	'badge',
	'card',
	'cursor',
	'ripple',
	'toast',
	'caption',
	'panel',
	'launcher',
];

type DialogShowModal = HTMLDialogElement['showModal'];
type ShowPopover = HTMLElement['showPopover'];
type TogglePopover = HTMLElement['togglePopover'];

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

class OverlayImpl implements Overlay {
	private hostEl: HTMLElement | null = null;
	private rootEl: ShadowRoot | null = null;
	private partEls: Record<PartName, HTMLElement> | null = null;
	private current: Element | null = null;
	private originals: {
		showModal: DialogShowModal;
		showPopover: ShowPopover;
		togglePopover: TogglePopover;
	} | null = null;
	private readonly onLayout = (): void => {
		if (this.current) this.layout();
	};

	get host(): HTMLElement {
		return this.ensure().host;
	}

	get root(): ShadowRoot {
		return this.ensure().root;
	}

	get parts(): Record<PartName, HTMLElement> {
		return this.ensure().parts;
	}

	private ensure(): { host: HTMLElement; root: ShadowRoot; parts: Record<PartName, HTMLElement> } {
		if (this.hostEl && this.rootEl && this.partEls) {
			return { host: this.hostEl, root: this.rootEl, parts: this.partEls };
		}
		const host = document.createElement('journey-overlay');
		host.setAttribute('popover', 'manual');
		host.style.cssText =
			'position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none';
		const root = host.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = CSS_TEXT;
		root.append(style);
		const parts = {} as Record<PartName, HTMLElement>;
		for (const name of PART_NAMES) {
			const el = document.createElement('div');
			el.className = name;
			el.setAttribute('part', name);
			el.hidden = name !== 'panel';
			if (name === 'cursor') el.innerHTML = CURSOR_SVG;
			root.append(el);
			parts[name] = el;
		}
		document.documentElement.append(host);
		this.hostEl = host;
		this.rootEl = root;
		this.partEls = parts;
		this.patch();
		this.raise();
		window.addEventListener('resize', this.onLayout);
		window.addEventListener('scroll', this.onLayout, true);
		return { host, root, parts };
	}

	// Popovers and modal dialogs enter the top layer above everything shown
	// before them, so the overlay re-enters the top layer after each such call.
	private patch(): void {
		if (this.originals) return;
		const showModal = HTMLDialogElement.prototype.showModal;
		const showPopover = HTMLElement.prototype.showPopover;
		const togglePopover = HTMLElement.prototype.togglePopover;
		this.originals = { showModal, showPopover, togglePopover };
		const overlay = this;
		HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
			showModal.call(this);
			overlay.raise();
		};
		HTMLElement.prototype.showPopover = function (this: HTMLElement, ...args: unknown[]) {
			(showPopover as (...a: unknown[]) => void).apply(this, args);
			if (this !== overlay.hostEl) overlay.raise();
		};
		HTMLElement.prototype.togglePopover = function (this: HTMLElement, ...args: unknown[]) {
			const result = (togglePopover as (...a: unknown[]) => boolean).apply(this, args);
			if (this !== overlay.hostEl) overlay.raise();
			return result;
		};
	}

	raise(): void {
		const host = this.hostEl;
		const originals = this.originals;
		if (!host || !originals || !host.isConnected) return;
		try {
			if (host.matches(':popover-open')) host.hidePopover();
			originals.showPopover.call(host);
		} catch {}
	}

	remove(): void {
		if (this.originals) {
			HTMLDialogElement.prototype.showModal = this.originals.showModal;
			HTMLElement.prototype.showPopover = this.originals.showPopover;
			HTMLElement.prototype.togglePopover = this.originals.togglePopover;
			this.originals = null;
		}
		window.removeEventListener('resize', this.onLayout);
		window.removeEventListener('scroll', this.onLayout, true);
		this.hostEl?.remove();
		this.hostEl = null;
		this.rootEl = null;
		this.partEls = null;
		this.current = null;
	}

	target(): DOMRect | null {
		if (!this.current?.isConnected) return null;
		const rect = this.current.getBoundingClientRect();
		return rect.width === 0 && rect.height === 0 ? null : rect;
	}

	track(el: Element | null, options: { scroll?: boolean } = {}): void {
		this.current = el;
		if (el && options.scroll !== false) el.scrollIntoView({ block: 'center', inline: 'nearest' });
		this.layout();
	}

	layout(): void {
		const parts = this.parts;
		const rect = this.target();
		const pad = 6;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const anchored = rect ? '' : 'hidden';
		for (const name of ['spot', 'badge', 'cursor', 'ripple'] as const) {
			parts[name].style.visibility = anchored;
		}
		if (rect) {
			Object.assign(parts.spot.style, {
				top: `${rect.top - pad}px`,
				left: `${rect.left - pad}px`,
				width: `${rect.width + pad * 2}px`,
				height: `${rect.height + pad * 2}px`,
			});
			Object.assign(parts.badge.style, {
				top: `${rect.top - pad - 13}px`,
				left: `${rect.left - pad - 13}px`,
			});
		}
		for (const name of ['card', 'caption'] as const) {
			const el = parts[name];
			if (el.hidden) continue;
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			if (!rect) {
				el.style.top = `${Math.max(12, (vh - h) / 2)}px`;
				el.style.left = `${Math.max(12, (vw - w) / 2)}px`;
				continue;
			}
			let top = rect.bottom + pad + 12;
			if (top + h > vh - 12) top = rect.top - pad - 12 - h;
			if (top < 12) top = 12;
			el.style.top = `${top}px`;
			el.style.left = `${clamp(rect.left, 12, Math.max(12, vw - w - 12))}px`;
		}
	}
}

export function createOverlay(): Overlay {
	return new OverlayImpl();
}
