import type { Presenter, ShowCtx } from './engine.js';
import { type Overlay, viewportRect } from './overlay.js';
import { defaultLocalize, type Localize } from './strings.js';

export const nonePresenter: Presenter = {
	show() {},
	settle() {},
	hide() {},
};

function hideAll(overlay: Overlay, keep: Array<keyof Overlay['parts']> = []): void {
	for (const [name, el] of Object.entries(overlay.parts)) {
		if (name === 'panel' || name === 'launcher') continue;
		el.hidden = !keep.includes(name as keyof Overlay['parts']);
	}
}

function button(
	label: string,
	hint: string | null,
	className: string,
	onClick: () => void,
): HTMLButtonElement {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = className;
	el.textContent = label;
	if (hint !== null) {
		const kbd = document.createElement('kbd');
		kbd.textContent = hint;
		el.append(' ', kbd);
	}
	el.addEventListener('click', onClick);
	return el;
}

function fillCard(
	card: HTMLElement,
	t: Localize,
	ctx: {
		title?: string;
		body?: string;
		meta?: string;
		next?: (() => void) | null;
		nextLabel?: string;
		exit: () => void;
		hints: boolean;
		escapeIsStep?: boolean;
	},
): HTMLButtonElement | null {
	card.replaceChildren();
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-live', 'polite');
	card.tabIndex = -1;
	if (ctx.title) {
		const h = document.createElement('h2');
		h.textContent = ctx.title;
		card.append(h);
		card.setAttribute('aria-label', ctx.title);
	} else card.removeAttribute('aria-label');
	if (ctx.body) {
		const p = document.createElement('p');
		p.id = 'journey-card-body';
		p.textContent = ctx.body;
		card.append(p);
		card.setAttribute('aria-describedby', p.id);
	} else card.removeAttribute('aria-describedby');
	const meta = document.createElement('div');
	meta.className = 'meta';
	const counter = document.createElement('span');
	counter.textContent = ctx.meta ?? '';
	const buttons = document.createElement('div');
	buttons.className = 'buttons';
	buttons.append(
		button(t('exit'), ctx.hints && !ctx.escapeIsStep ? 'Esc' : null, 'exit', ctx.exit),
	);
	let next: HTMLButtonElement | null = null;
	if (ctx.next) {
		next = button(ctx.nextLabel ?? t('next'), ctx.hints ? '\u21b5' : null, 'next', ctx.next);
		buttons.append(next);
	}
	meta.append(counter, buttons);
	card.append(meta);
	return next;
}

function deepActive(): Element | null {
	let el = document.activeElement;
	while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
	return el;
}

function focusLost(overlay: Overlay): boolean {
	const active = document.activeElement;
	return !active || active === document.body || active === overlay.host;
}

function focusOn(el: Element | null): boolean {
	if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
	el.focus({ preventScroll: true });
	return deepActive() === el;
}

// Without a Next button, focus moves only when it was lost or sat in the
// overlay, so a user typing in the page is never pulled away.
function placeFocus(
	overlay: Overlay,
	el: Element | null,
	next: HTMLButtonElement | null,
	acts: boolean,
): void {
	if (next) {
		focusOn(next);
		return;
	}
	if (!focusLost(overlay)) return;
	if (acts && el && focusOn(el)) return;
	focusOn(overlay.parts.card);
}

function toast(overlay: Overlay, t: Localize, ctx: ShowCtx): void {
	const el = overlay.parts.toast;
	if (ctx.action.kind !== 'press') {
		el.hidden = true;
		return;
	}
	el.replaceChildren(`${t('press')} `);
	const kbd = document.createElement('kbd');
	kbd.textContent = ctx.action.key;
	el.append(kbd);
	el.hidden = false;
}

function cursorPresenter(overlay: Overlay): Pick<Presenter, 'moveCursor' | 'ripple'> {
	return {
		moveCursor(el) {
			const cursor = overlay.parts.cursor;
			const rect = viewportRect(el);
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			const first = cursor.hidden;
			cursor.hidden = false;
			if (first) cursor.style.transition = 'none';
			const next = `translate(${x - 4}px, ${y - 2}px)`;
			const moved = cursor.style.transform !== next;
			cursor.style.transform = next;
			if (first) {
				void cursor.offsetWidth;
				cursor.style.transition = '';
				return Promise.resolve();
			}
			const style = getComputedStyle(cursor);
			const duration = Number.parseFloat(style.transitionDuration);
			if (!moved || !(duration > 0)) return Promise.resolve();
			const delay = Number.parseFloat(style.transitionDelay) || 0;
			// A transition that never starts fires neither event, and no caller has a
			// timeout, so without this the run hangs on the step forever.
			return new Promise((resolve) => {
				const timer = setTimeout(done, (duration + Math.max(delay, 0)) * 1000 + 250);
				function done(): void {
					clearTimeout(timer);
					cursor.removeEventListener('transitionend', done);
					cursor.removeEventListener('transitioncancel', done);
					resolve();
				}
				cursor.addEventListener('transitionend', done);
				cursor.addEventListener('transitioncancel', done);
			});
		},
		ripple(el) {
			const ripple = overlay.parts.ripple;
			const rect = viewportRect(el);
			ripple.style.left = `${rect.left + rect.width / 2}px`;
			ripple.style.top = `${rect.top + rect.height / 2}px`;
			ripple.hidden = false;
			ripple.classList.remove('on');
			void ripple.offsetWidth;
			ripple.classList.add('on');
		},
	};
}

const NEXT_KEYS = ['Enter', ' ', 'ArrowRight'];

function editable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return target.matches('input,textarea,select');
}

const HOST_LAYER = 'dialog[open],[popover],[role="menu"],[role="listbox"]';

function hostTakesEscape(target: EventTarget | null, overlay: Overlay): boolean {
	if (!(target instanceof Element) || overlay.host.contains(target)) return false;
	return target.matches('[aria-expanded="true"]') || target.closest(HOST_LAYER) !== null;
}

export function guidePresenter(overlay: Overlay, t: Localize = defaultLocalize): Presenter {
	const cursor = cursorPresenter(overlay);
	let onKey: ((event: KeyboardEvent) => void) | null = null;
	let onEscape: ((event: KeyboardEvent) => void) | null = null;
	const detachKey = (): void => {
		if (onKey) window.removeEventListener('keydown', onKey, true);
		if (onEscape) window.removeEventListener('keydown', onEscape);
		onKey = null;
		onEscape = null;
	};
	const attachKey = (exit: () => void, next: (() => void) | null, escapeIsStep = false): void => {
		detachKey();
		onKey = (event) => {
			if (!event.isTrusted || !next || !NEXT_KEYS.includes(event.key)) return;
			if (editable(event.target) && !overlay.host.contains(event.target as Node)) return;
			event.preventDefault();
			next();
		};
		onEscape = (event) => {
			if (!event.isTrusted || event.key !== 'Escape' || escapeIsStep) return;
			if (event.defaultPrevented || hostTakesEscape(event.target, overlay)) return;
			exit();
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('keydown', onEscape);
	};
	let human = true;
	let before: Element | null = null;
	const remember = (): void => {
		if (before === null) before = document.activeElement ?? document.body;
	};
	return {
		show(_step, el, ctx) {
			remember();
			human = ctx.human;
			const hints = ctx.human || ctx.stepped;
			const escapeIsStep = ctx.action.kind === 'press' && ctx.action.key === 'Escape';
			if (hints) attachKey(ctx.exit, ctx.next, escapeIsStep);
			else detachKey();
			const { spot, card } = overlay.parts;
			spot.classList.remove('doc');
			const cursorPart = ctx.human ? [] : ['cursor' as const];
			hideAll(overlay, el ? ['spot', 'card', ...cursorPart] : ['card', ...cursorPart]);
			const next = fillCard(card, t, {
				title: ctx.title,
				body: ctx.body,
				meta: t('step', { i: ctx.index + 1, n: ctx.total }),
				next: ctx.next,
				exit: ctx.exit,
				hints,
				escapeIsStep,
			});
			toast(overlay, t, ctx);
			overlay.track(el);
			overlay.raise();
			const acts = ctx.human && ctx.action.kind !== 'none';
			placeFocus(overlay, el, next, acts);
		},
		settle() {
			overlay.parts.toast.hidden = true;
			overlay.layout();
		},
		hide() {
			detachKey();
			const restore = focusLost(overlay) ? before : null;
			before = null;
			hideAll(overlay);
			overlay.track(null);
			if (restore?.isConnected && restore !== document.body) focusOn(restore);
		},
		message(title, body, exit, next, nextLabel) {
			remember();
			attachKey(exit, next ?? null);
			hideAll(overlay, ['card']);
			const button = fillCard(overlay.parts.card, t, {
				title,
				body,
				exit,
				next,
				nextLabel,
				hints: true,
			});
			overlay.track(null);
			overlay.raise();
			placeFocus(overlay, null, button, false);
		},
		moveCursor(el) {
			return human ? Promise.resolve() : (cursor.moveCursor as (el: Element) => Promise<void>)(el);
		},
		ripple(el) {
			if (!human) cursor.ripple?.(el);
		},
	};
}

export function docPresenter(
	overlay: Overlay,
	t: Localize = defaultLocalize,
	options: { caption?: boolean } = {},
): Presenter {
	const cursor = cursorPresenter(overlay);
	const captions = options.caption !== false;
	let human = false;
	return {
		show(_step, el, ctx) {
			human = ctx.human;
			const { spot, badge, caption } = overlay.parts;
			spot.classList.add('doc');
			badge.textContent = String(ctx.index + 1);
			const text = captions ? [ctx.title, ctx.body].filter((t) => t).join(' — ') : '';
			caption.textContent = text;
			const extra = [
				...(text ? ['caption' as const] : []),
				...(ctx.human ? [] : ['cursor' as const]),
			];
			hideAll(overlay, el ? ['spot', 'badge', ...extra] : extra);
			toast(overlay, t, ctx);
			overlay.track(el);
			overlay.raise();
		},
		settle() {
			overlay.parts.toast.hidden = true;
			overlay.layout();
		},
		hide() {
			hideAll(overlay);
			overlay.track(null);
		},
		moveCursor(el) {
			return human ? Promise.resolve() : (cursor.moveCursor as (el: Element) => Promise<void>)(el);
		},
		ripple(el) {
			if (!human) cursor.ripple?.(el);
		},
	};
}

export function spotPresenter(overlay: Overlay, t: Localize = defaultLocalize): Presenter {
	return docPresenter(overlay, t, { caption: false });
}
