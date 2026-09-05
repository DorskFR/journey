import type { Presenter, ShowCtx } from './engine.js';
import type { Overlay } from './overlay.js';

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

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = className;
	el.textContent = label;
	el.addEventListener('click', onClick);
	return el;
}

function fillCard(
	card: HTMLElement,
	ctx: {
		title?: string;
		body?: string;
		meta?: string;
		next?: (() => void) | null;
		exit: () => void;
	},
): void {
	card.replaceChildren();
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-live', 'polite');
	if (ctx.title) {
		const h = document.createElement('h2');
		h.textContent = ctx.title;
		card.append(h);
		card.setAttribute('aria-label', ctx.title);
	}
	if (ctx.body) {
		const p = document.createElement('p');
		p.textContent = ctx.body;
		card.append(p);
	}
	const meta = document.createElement('div');
	meta.className = 'meta';
	const counter = document.createElement('span');
	counter.textContent = ctx.meta ?? '';
	const buttons = document.createElement('div');
	buttons.className = 'buttons';
	buttons.append(button('Exit', 'exit', ctx.exit));
	if (ctx.next) buttons.append(button('Next', 'next', ctx.next));
	meta.append(counter, buttons);
	card.append(meta);
}

function toast(overlay: Overlay, ctx: ShowCtx): void {
	const el = overlay.parts.toast;
	if (ctx.action.kind !== 'press') {
		el.hidden = true;
		return;
	}
	el.replaceChildren('Press ');
	const kbd = document.createElement('kbd');
	kbd.textContent = ctx.action.key;
	el.append(kbd);
	el.hidden = false;
}

function cursorPresenter(overlay: Overlay): Pick<Presenter, 'moveCursor' | 'ripple'> {
	return {
		moveCursor(el) {
			const cursor = overlay.parts.cursor;
			const rect = el.getBoundingClientRect();
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
			const duration = Number.parseFloat(getComputedStyle(cursor).transitionDuration);
			if (!moved || !(duration > 0)) return Promise.resolve();
			return new Promise((resolve) => {
				const done = (): void => resolve();
				cursor.addEventListener('transitionend', done, { once: true });
				cursor.addEventListener('transitioncancel', done, { once: true });
			});
		},
		ripple(el) {
			const ripple = overlay.parts.ripple;
			const rect = el.getBoundingClientRect();
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

export function guidePresenter(overlay: Overlay): Presenter {
	const cursor = cursorPresenter(overlay);
	let onKey: ((event: KeyboardEvent) => void) | null = null;
	const detachKey = (): void => {
		if (onKey) window.removeEventListener('keydown', onKey, true);
		onKey = null;
	};
	const attachKey = (exit: () => void, next: (() => void) | null): void => {
		detachKey();
		onKey = (event) => {
			if (!event.isTrusted) return;
			if (event.key === 'Escape') {
				exit();
				return;
			}
			if (!next || !NEXT_KEYS.includes(event.key)) return;
			if (editable(event.target) && !overlay.host.contains(event.target as Node)) return;
			event.preventDefault();
			next();
		};
		window.addEventListener('keydown', onKey, true);
	};
	let human = true;
	return {
		show(_step, el, ctx) {
			human = ctx.human;
			if (ctx.human || ctx.stepped) attachKey(ctx.exit, ctx.next);
			else detachKey();
			const { spot, card } = overlay.parts;
			spot.classList.remove('doc');
			const cursorPart = ctx.human ? [] : ['cursor' as const];
			hideAll(overlay, el ? ['spot', 'card', ...cursorPart] : ['card', ...cursorPart]);
			fillCard(card, {
				title: ctx.title,
				body: ctx.body,
				meta: `Step ${ctx.index + 1} of ${ctx.total}`,
				next: ctx.next,
				exit: ctx.exit,
			});
			toast(overlay, ctx);
			overlay.track(el);
			overlay.raise();
		},
		settle() {
			overlay.parts.toast.hidden = true;
			overlay.layout();
		},
		hide() {
			detachKey();
			hideAll(overlay);
			overlay.track(null);
		},
		message(title, body, exit, next) {
			attachKey(exit, next ?? null);
			hideAll(overlay, ['card']);
			fillCard(overlay.parts.card, { title, body, exit, next });
			overlay.track(null);
			overlay.raise();
		},
		moveCursor(el) {
			return human ? Promise.resolve() : (cursor.moveCursor as (el: Element) => Promise<void>)(el);
		},
		ripple(el) {
			if (!human) cursor.ripple?.(el);
		},
	};
}

export function docPresenter(overlay: Overlay): Presenter {
	const cursor = cursorPresenter(overlay);
	let human = false;
	return {
		show(_step, el, ctx) {
			human = ctx.human;
			const { spot, badge, caption } = overlay.parts;
			spot.classList.add('doc');
			badge.textContent = String(ctx.index + 1);
			const text = [ctx.title, ctx.body].filter((t) => t).join(' — ');
			caption.textContent = text;
			const extra = [
				...(text ? ['caption' as const] : []),
				...(ctx.human ? [] : ['cursor' as const]),
			];
			hideAll(overlay, el ? ['spot', 'badge', ...extra] : extra);
			toast(overlay, ctx);
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
