import type { Interaction, IRStep } from '../core/types.js';
import type { Actor, ActorCtx } from './engine.js';
import { isParamRef } from './text.js';

function keyCode(key: string): string {
	if (key.length === 1) {
		if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
		if (/[0-9]/.test(key)) return `Digit${key}`;
		if (key === ' ') return 'Space';
	}
	return key;
}

function nativeSetter(el: Element): ((value: string) => void) | null {
	const proto =
		el instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: el instanceof HTMLInputElement
				? HTMLInputElement.prototype
				: null;
	if (!proto) return null;
	const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
	return descriptor?.set ? (value) => descriptor.set?.call(el, value) : null;
}

function fire(el: Element, type: string, init: EventInit = {}): void {
	el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

function waitEvent(
	el: Element,
	type: string,
	ctx: ActorCtx,
	accept: (event: Event) => boolean = () => true,
): Promise<void> {
	return new Promise((resolve) => {
		const controller = new AbortController();
		const finish = (): void => {
			controller.abort();
			resolve();
		};
		el.addEventListener(
			type,
			(event) => {
				if (accept(event)) finish();
			},
			{ capture: true, signal: controller.signal },
		);
		ctx.signal.addEventListener('abort', finish, { once: true, signal: controller.signal });
		ctx.next.then(finish);
	});
}

function requireEl(step: IRStep, el: Element | null): Element {
	if (!el) throw new Error(`step ${step.id}: interaction "${step.do.kind}" needs a target`);
	return el;
}

function assignRoute(route: string): void {
	const hash = route.indexOf('#');
	if (hash > 0 && route.slice(0, hash) === location.pathname) {
		location.hash = route.slice(hash);
		return;
	}
	const url = new URL(route, location.href);
	const flag = new URLSearchParams(location.search).get('journey');
	if (flag !== null && !url.searchParams.has('journey')) url.searchParams.set('journey', flag);
	location.href = url.href;
}

export const domActor: Actor = {
	async navigate(route) {
		assignRoute(route);
	},
	async perform(step, el, action) {
		switch (action.kind) {
			case 'none':
				return;
			case 'navigate':
				location.href = action.url;
				return;
			case 'click':
				(requireEl(step, el) as HTMLElement).click();
				return;
			case 'dblclick':
				requireEl(step, el).dispatchEvent(
					new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
				);
				return;
			case 'fill': {
				const target = requireEl(step, el) as HTMLInputElement;
				target.focus();
				const setter = nativeSetter(target);
				if (setter) setter(action.value as string);
				else target.value = action.value as string;
				fire(target, 'input');
				fire(target, 'change');
				return;
			}
			case 'select': {
				const target = requireEl(step, el) as HTMLSelectElement;
				target.value = action.value as string;
				fire(target, 'input');
				fire(target, 'change');
				return;
			}
			case 'check': {
				const target = requireEl(step, el) as HTMLInputElement;
				target.checked = action.checked;
				fire(target, 'input');
				fire(target, 'change');
				return;
			}
			case 'press': {
				const target = requireEl(step, el);
				const init = {
					key: action.key,
					code: keyCode(action.key),
					bubbles: true,
					cancelable: true,
				};
				target.dispatchEvent(new KeyboardEvent('keydown', init));
				target.dispatchEvent(new KeyboardEvent('keypress', init));
				target.dispatchEvent(new KeyboardEvent('keyup', init));
				return;
			}
			case 'hover': {
				const target = requireEl(step, el);
				for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
					const bubbles = type === 'pointerover' || type === 'mouseover';
					target.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true }));
				}
				return;
			}
		}
	},
};

export const steppedActor: Actor = {
	stepped: true,
	async navigate(route, ctx) {
		ctx.presenter.message?.(
			'Go to another page',
			`Press Next to open ${route}.`,
			ctx.exit,
			ctx.proceed,
		);
		await ctx.next;
		if (!ctx.signal.aborted) await domActor.navigate(route, ctx);
	},
	async perform(step, el, action, ctx) {
		await ctx.next;
		if (!ctx.signal.aborted) await domActor.perform(step, el, action, ctx);
	},
};

export const humanActor: Actor = {
	human: true,
	async navigate(route, ctx) {
		ctx.presenter.message?.('Go to another page', `Open ${route} to continue.`, ctx.exit);
	},
	async perform(step, el, action, ctx) {
		if (action.kind === 'none' || action.kind === 'navigate') {
			await ctx.next;
			if (action.kind === 'navigate' && !ctx.signal.aborted) location.href = action.url;
			return;
		}
		const target = requireEl(step, el);
		let viaNext = true;
		const wait = (type: string, accept?: (event: Event) => boolean): Promise<void> =>
			waitEvent(target, type, ctx, (event) => {
				const ok = accept ? accept(event) : true;
				if (ok) viaNext = false;
				return ok;
			});
		switch (action.kind) {
			case 'click':
			case 'dblclick':
				await wait(action.kind);
				break;
			case 'fill': {
				const literal = !isParamRef(step.do.kind === 'fill' ? step.do.value : undefined);
				const matches = (): boolean =>
					!literal || (target as HTMLInputElement).value === (action.value as string);
				await Promise.race([wait('input', matches), wait('change', matches)]);
				break;
			}
			case 'select':
			case 'check':
				await wait('change');
				break;
			case 'press':
				await wait('keydown', (event) => (event as KeyboardEvent).key === action.key);
				break;
			case 'hover':
				await wait('pointerenter');
				break;
		}
		if (viaNext && !ctx.signal.aborted) await domActor.perform(step, el, action, ctx);
	},
};

export interface DriverYield {
	stepId: string;
	route?: string;
	action?: Interaction | null;
	marker?: string | null;
}

export const MARKER = 'data-journey-focus';

export class DriverActor implements Actor {
	pending: DriverYield | null = null;
	onYield: ((y: DriverYield) => void) | null = null;
	private actedResolve: (() => void) | null = null;
	private proceedResolve: (() => void) | null = null;

	acted(): void {
		const resolve = this.actedResolve;
		this.actedResolve = null;
		resolve?.();
	}

	proceed(): void {
		const resolve = this.proceedResolve;
		this.proceedResolve = null;
		resolve?.();
	}

	navigate(route: string, ctx: ActorCtx): Promise<void> {
		return new Promise<void>((resolve) => {
			ctx.signal.addEventListener('abort', () => resolve(), { once: true });
			this.pending = { stepId: '', route };
			this.onYield?.(this.pending);
		});
	}

	perform(step: IRStep, el: Element | null, action: Interaction, ctx: ActorCtx): Promise<void> {
		return this.yieldAction(step, el, action.kind === 'none' ? null : action, ctx);
	}

	resume(step: IRStep, ctx: ActorCtx): Promise<void> {
		return this.yieldAction(step, null, null, ctx);
	}

	afterStep(_step: IRStep, _index: number, ctx: ActorCtx): Promise<void> {
		return new Promise<void>((resolve) => {
			this.proceedResolve = resolve;
			ctx.signal.addEventListener('abort', () => resolve(), { once: true });
		});
	}

	private yieldAction(
		step: IRStep,
		el: Element | null,
		action: Interaction | null,
		ctx: ActorCtx,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			const marker = action && el ? step.id : null;
			if (marker && el) el.setAttribute(MARKER, marker);
			const finish = (): void => {
				if (el) el.removeAttribute(MARKER);
				this.pending = null;
				resolve();
			};
			this.actedResolve = finish;
			ctx.signal.addEventListener('abort', finish, { once: true });
			this.pending = { stepId: step.id, action, marker };
			if (action) ctx.markActed();
			this.onYield?.(this.pending);
		});
	}
}
