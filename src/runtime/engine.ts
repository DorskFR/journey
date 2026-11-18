import type {
	Capture,
	Expectation,
	Interaction,
	IR,
	IRStep,
	Pace,
	PresenterName,
	Target,
} from '../core/types.js';
import { Masker } from './mask.js';
import { ambiguityHint, describeTarget, resolveAll, resolveOne } from './resolve.js';
import { watchRoute } from './route.js';
import {
	currentLocale,
	isParamRef,
	type Params,
	resolveParam,
	resolveStepParams,
	resolveText,
	type Translate,
} from './text.js';

export type { Pace, PresenterName };

export interface RunResult {
	ok: boolean;
	completed: number;
	failures: Array<{ stepId: string; error: string }>;
	aborted?: boolean;
}

export type NavigateHook = (route: string) => void | Promise<void>;

export interface ActorCtx {
	signal: AbortSignal;
	next: Promise<void>;
	presenter: Presenter;
	params: Params;
	exit: () => void;
	proceed: () => void;
	markActed: () => void;
	navigate?: NavigateHook;
}

export interface Actor {
	human?: boolean;
	stepped?: boolean;
	navigate(route: string, ctx: ActorCtx): Promise<void>;
	perform(step: IRStep, el: Element | null, action: Interaction, ctx: ActorCtx): Promise<void>;
	resume?(step: IRStep, ctx: ActorCtx): Promise<void>;
	afterStep?(step: IRStep, index: number, ctx: ActorCtx): Promise<void>;
}

export interface ShowCtx {
	index: number;
	total: number;
	title?: string;
	body?: string;
	action: Interaction;
	human: boolean;
	stepped: boolean;
	next: (() => void) | null;
	exit: () => void;
}

export interface Presenter {
	show(step: IRStep, el: Element | null, ctx: ShowCtx): void;
	settle(step: IRStep): void | Promise<void>;
	hide(): void;
	message?(
		title: string,
		body: string,
		exit: () => void,
		next?: () => void,
		nextLabel?: string,
	): void;
	moveCursor?(el: Element): Promise<void>;
	ripple?(el: Element): void;
}

export interface ProgressSink {
	save(index: number, acted: boolean, navigated?: boolean): void;
	clear(): void;
}

export interface EngineDeps {
	actor: Actor;
	presenter: Presenter;
	presenterFor?: (name: PresenterName) => Presenter;
	params: Params;
	variant: Record<string, string>;
	translate?: Translate;
	probes?: Record<string, () => unknown | Promise<unknown>>;
	pace?: Pace;
	mask?: boolean;
	masks?: string[];
	track?: (event: string, data: Record<string, unknown>) => void;
	progress?: ProgressSink;
	navigate?: NavigateHook;
}

export type EngineEvent =
	| 'journey:start'
	| 'step:start'
	| 'step:resolved'
	| 'step:acted'
	| 'step:pass'
	| 'step:fail'
	| 'step:skip'
	| 'journey:done'
	| 'journey:abort';

export type Listener = (data: Record<string, unknown>) => void;

export const POLL_INTERVAL = 100;
export const POLL_MAX_INTERVAL = 1000;
const POLL_BACKOFF_AFTER = 1000;

class AbortError extends Error {
	constructor() {
		super('Journey run aborted');
		this.name = 'AbortError';
	}
}

class StepSkip extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'StepSkip';
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ms <= 0) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			reject(new AbortError());
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

// Resolves after the next DOM mutation or route change, or after `ms` when neither happens.
function watchChanges(): { next: (ms: number) => Promise<void>; stop: () => void } {
	let wake: (() => void) | null = null;
	const changed = (): void => wake?.();
	const observer = typeof MutationObserver === 'function' ? new MutationObserver(changed) : null;
	observer?.observe(document, {
		subtree: true,
		childList: true,
		attributes: true,
		characterData: true,
	});
	const unroute = typeof history === 'object' ? watchRoute(changed) : () => {};
	return {
		next: (ms) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(done, ms);
				function done(): void {
					clearTimeout(timer);
					wake = null;
					resolve();
				}
				wake = done;
			}),
		stop: () => {
			observer?.disconnect();
			unroute();
		},
	};
}

function splitQuery(pattern: string): { path: string; query: string | null } {
	const hash = pattern.indexOf('#');
	const mark = pattern.indexOf('?');
	if (mark === -1 || (hash !== -1 && hash < mark)) return { path: pattern, query: null };
	const end = hash === -1 ? pattern.length : hash;
	return { path: pattern.slice(0, mark) + pattern.slice(end), query: pattern.slice(mark + 1, end) };
}

function withoutTrailingSlash(path: string): string {
	const hash = path.indexOf('#');
	const pathname = hash === -1 ? path : path.slice(0, hash);
	const rest = hash === -1 ? '' : path.slice(hash);
	return (pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname) + rest;
}

function queryHolds(query: string): boolean {
	const have = new URLSearchParams(location.search);
	return [...new URLSearchParams(query)].every(([key, value]) => have.getAll(key).includes(value));
}

export function matchesRoute(route: string): boolean {
	return withoutTrailingSlash(currentPath(route)) === withoutTrailingSlash(route);
}

export function matchesUrl(pattern: string): boolean {
	const { path, query } = splitQuery(pattern);
	if (query !== null && !queryHolds(query)) return false;
	const current = withoutTrailingSlash(currentPath(path));
	const wanted = withoutTrailingSlash(path);
	if (!wanted.includes('*')) return current === wanted;
	const source = wanted
		.split('**')
		.map((part) =>
			part
				.split('*')
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
				.join('[^/]*'),
		)
		.join('.*');
	return new RegExp(`^${source}$`).test(current);
}

function currentPath(pattern: string): string {
	return pattern.includes('#') ? location.pathname + location.hash : location.pathname;
}

function currentUrl(pattern: string): string {
	const search = splitQuery(pattern).query === null ? '' : location.search;
	return location.pathname + search + (pattern.includes('#') ? location.hash : '');
}

function redacted(step: IRStep, action: Interaction): Interaction {
	return isMaskedFill(step) && action.kind === 'fill' ? { ...action, value: '***' } : action;
}

function isMaskedFill(step: IRStep): boolean {
	return step.do.kind === 'fill' && step.do.mask === true;
}

function elementValue(el: Element): string {
	return (el as HTMLInputElement).value ?? '';
}

export class Engine {
	readonly ir: IR;
	readonly deps: EngineDeps;
	index = -1;
	private readonly listeners = new Map<EngineEvent, Set<Listener>>();
	private controller = new AbortController();
	private readonly masker = new Masker();
	private running = false;
	private exitRequested = false;

	constructor(ir: IR, deps: EngineDeps) {
		this.ir = ir;
		this.deps = deps;
	}

	on(event: EngineEvent, listener: Listener): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => set?.delete(listener);
	}

	private emit(event: EngineEvent, data: Record<string, unknown> = {}): void {
		const payload = { journey: this.ir.id, ...data };
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
		this.deps.track?.(event, payload);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get aborted(): boolean {
		return this.controller.signal.aborted;
	}

	stop(): void {
		if (!this.running) return;
		this.exitRequested = true;
		this.controller.abort();
	}

	private race<T>(promise: Promise<T>): Promise<T> {
		if (this.aborted) return Promise.reject(new AbortError());
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => reject(new AbortError());
			this.signal.addEventListener('abort', onAbort, { once: true });
			promise.then(
				(v) => {
					this.signal.removeEventListener('abort', onAbort);
					resolve(v);
				},
				(e) => {
					this.signal.removeEventListener('abort', onAbort);
					reject(e);
				},
			);
		});
	}

	private bounded<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
		return this.race(
			new Promise<{ value: T } | null>((resolve, reject) => {
				const timer = setTimeout(() => resolve(null), Math.max(0, ms));
				promise.then(
					(value) => {
						clearTimeout(timer);
						resolve({ value });
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			}),
		);
	}

	private async within(label: string, work: void | Promise<void>, ms: number): Promise<void> {
		if (!(await this.bounded(Promise.resolve(work), ms))) {
			throw new Error(`${label}: no result after ${ms}ms`);
		}
	}

	private watchDetach(el: Element): {
		signal: AbortSignal;
		detached: () => boolean;
		stop: () => void;
	} {
		const controller = new AbortController();
		let detached = false;
		const onAbort = (): void => controller.abort();
		this.signal.addEventListener('abort', onAbort, { once: true });
		const timer = setInterval(() => {
			if (el.isConnected) return;
			detached = true;
			controller.abort();
		}, POLL_INTERVAL);
		return {
			signal: controller.signal,
			detached: () => detached,
			stop: () => {
				clearInterval(timer);
				this.signal.removeEventListener('abort', onAbort);
			},
		};
	}

	private async poll<T>(
		fn: () => T | undefined | Promise<T | undefined>,
		timeout: number | null,
	): Promise<T | undefined> {
		const deadline = timeout === null ? Number.POSITIVE_INFINITY : performance.now() + timeout;
		const started = performance.now();
		const changes = watchChanges();
		let interval = POLL_INTERVAL;
		try {
			for (;;) {
				if (this.aborted) throw new AbortError();
				const value = await fn();
				if (value !== undefined) return value;
				if (performance.now() >= deadline) return undefined;
				await sleep(POLL_INTERVAL, this.signal);
				if (performance.now() - started < POLL_BACKOFF_AFTER) continue;
				interval = Math.min(interval * 2, POLL_MAX_INTERVAL);
				const rest = Math.min(interval - POLL_INTERVAL, deadline - performance.now());
				if (rest > 0) await this.race(changes.next(rest));
			}
		} finally {
			changes.stop();
		}
	}

	text(text: Parameters<typeof resolveText>[0]): string | undefined {
		return resolveText(text, this.deps.translate, currentLocale(this.deps.variant));
	}

	private resolveAction(step: IRStep): Interaction {
		const action = step.do;
		if (action.kind === 'fill' || action.kind === 'select') {
			return { ...action, value: resolveParam(action.value, this.deps.params) };
		}
		return action;
	}

	private stepParams(step: IRStep): Params {
		return { ...this.deps.params, ...resolveStepParams(step.params, this.deps.params) };
	}

	private async checkExpectation(
		e: Expectation,
		params: Params,
		deadline: number,
	): Promise<string | null> {
		const single = (target: Target, label: string, labelled = false) => {
			const r = resolveOne(target, params, document, { labelled });
			if (r.error === 'notfound') return { error: `${label} ${describeTarget(target)}: 0 matches` };
			if (r.error === 'ambiguous') {
				return { error: `${label} ${describeTarget(target)}: ${r.count} matches` };
			}
			return { el: r.el };
		};
		if ('visible' in e) {
			const n = resolveAll(e.visible, params).length;
			return n > 0 ? null : `visible ${describeTarget(e.visible)}: 0 matches`;
		}
		if ('hidden' in e) {
			const n = resolveAll(e.hidden, params).length;
			return n === 0 ? null : `hidden ${describeTarget(e.hidden)}: ${n} visible`;
		}
		if ('text' in e) {
			const [target, text] = e.text;
			const expected = this.text(text) ?? '';
			const matches = resolveAll(target, params);
			if (matches.some((el) => (el.textContent ?? '').trim().includes(expected))) return null;
			const observed =
				matches.length === 0 ? '0 matches' : JSON.stringify((matches[0]?.textContent ?? '').trim());
			return `text ${describeTarget(target)} ${JSON.stringify(expected)}: ${observed}`;
		}
		if ('value' in e) {
			const [target, value] = e.value;
			const expected = resolveParam(value, params);
			const r = single(target, 'value', true);
			if (r.error !== undefined) return r.error;
			const actual = elementValue(r.el);
			return actual === expected
				? null
				: `value ${describeTarget(target)} ${JSON.stringify(expected)}: ${JSON.stringify(actual)}`;
		}
		if ('checked' in e) {
			const [target, expected] = e.checked;
			const r = single(target, 'checked', true);
			if (r.error !== undefined) return r.error;
			const actual = (r.el as HTMLInputElement).checked === true;
			return actual === expected
				? null
				: `checked ${describeTarget(target)} ${expected}: ${actual}`;
		}
		if ('enabled' in e || 'disabled' in e) {
			const wantEnabled = 'enabled' in e;
			const target = wantEnabled ? e.enabled : e.disabled;
			const label = wantEnabled ? 'enabled' : 'disabled';
			const r = single(target, label);
			if (r.error !== undefined) return r.error;
			const disabled = r.el.matches(':disabled');
			return disabled === !wantEnabled
				? null
				: `${label} ${describeTarget(target)}: ${disabled ? 'disabled' : 'enabled'}`;
		}
		if ('url' in e) {
			return matchesUrl(e.url) ? null : `url ${e.url}: ${currentUrl(e.url)}`;
		}
		if ('count' in e) {
			const [target, range] = e.count;
			const n = resolveAll(target, params).length;
			const ok =
				(range.equals === undefined || n === range.equals) &&
				(range.min === undefined || n >= range.min) &&
				(range.max === undefined || n <= range.max);
			return ok ? null : `count ${describeTarget(target)}: ${n}`;
		}
		if ('event' in e) {
			return this.firedEvents.has(e.event) ? null : `event ${e.event}: not fired`;
		}
		const probe = this.deps.probes?.[e.probe];
		if (!probe) return `probe ${e.probe}: not registered`;
		let answer: { value: unknown } | null;
		try {
			answer = await this.bounded(Promise.resolve().then(probe), deadline - performance.now());
		} catch (error) {
			if (error instanceof AbortError) throw error;
			return `probe ${e.probe}: threw ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!answer) return `probe ${e.probe}: no answer before the step timeout`;
		const observed = answer.value;
		if (
			e.equals === undefined
				? Boolean(observed)
				: JSON.stringify(observed) === JSON.stringify(e.equals)
		) {
			return null;
		}
		return `probe ${e.probe}: ${JSON.stringify(observed) ?? String(observed)}`;
	}

	private firedEvents = new Set<string>();

	private listenEvents(step: IRStep): () => void {
		this.firedEvents = new Set();
		const names = (step.expect ?? []).flatMap((e) => ('event' in e ? [e.event] : []));
		const handlers = names.map((name) => {
			const handler = (): void => {
				this.firedEvents.add(name);
			};
			window.addEventListener(name, handler);
			return () => window.removeEventListener(name, handler);
		});
		return () => {
			for (const off of handlers) off();
		};
	}

	private async waitExpectations(step: IRStep, params: Params): Promise<void> {
		const expectations = step.expect ?? [];
		if (expectations.length === 0) return;
		let lastError: string | null = null;
		const deadline = performance.now() + step.timeout;
		const passed = await this.poll(async () => {
			for (const e of expectations) {
				const error = await this.checkExpectation(e, params, deadline);
				if (error !== null) {
					lastError = error;
					return undefined;
				}
			}
			return true;
		}, step.timeout);
		if (passed !== true) throw new Error(lastError ?? 'expectation failed');
	}

	private applyMasks(params: Params): void {
		if (this.deps.mask) {
			this.masker.apply([...(this.ir.mask ?? []), ...(this.deps.masks ?? [])], params);
		} else {
			this.masker.refresh();
		}
	}

	private keepMasked(step: IRStep, params: Params, el: Element | null): void {
		if (this.deps.actor.human || step.target === undefined) return;
		if (!isMaskedFill(step)) return;
		this.masker.keep(step.target, params, el);
	}

	private async resolveTarget(step: IRStep, params: Params): Promise<Element | null> {
		if (step.target === undefined) return null;
		const target = step.target;
		const found = await this.poll<{ el: Element } | { count: number }>(() => {
			const r = resolveOne(target, params);
			if (r.error === undefined) return { el: r.el };
			if (r.error === 'ambiguous') return { count: r.count };
			return undefined;
		}, step.timeout);
		if (found === undefined) {
			if (step.optional) throw new StepSkip(`target ${describeTarget(target)} not found`);
			throw new Error(`target ${describeTarget(target)}: 0 matches after ${step.timeout}ms`);
		}
		if ('count' in found) {
			throw new Error(
				`target ${describeTarget(target)}: ambiguous, ${found.count} matches${ambiguityHint(target)}`,
			);
		}
		return found.el;
	}

	private shouldSkip(step: IRStep): boolean {
		return Object.entries(step.when ?? {}).some(([dim, value]) => this.deps.variant[dim] !== value);
	}

	async run(from = 0, resume: { acted?: boolean; navigated?: boolean } = {}): Promise<RunResult> {
		if (this.running) throw new Error('Engine is already running');
		this.running = true;
		this.exitRequested = false;
		this.controller = new AbortController();
		const { actor, presenter, pace, progress } = this.deps;
		// A human drives through the presenter, so a step may not take it away from them.
		const scripted: boolean = actor.human !== true && actor.stepped !== true;
		let visible: Presenter = presenter;
		const presenterOf = (step: IRStep): Presenter => {
			const pick = this.deps.presenterFor;
			if (!scripted || !pick || step.presenter === undefined) return presenter;
			return pick(step.presenter);
		};
		const paceOf = (step: IRStep, phase: keyof Pace): number =>
			(scripted ? step.pace?.[phase] : undefined) ?? pace?.[phase] ?? 0;
		const result: RunResult = { ok: true, completed: 0, failures: [] };
		const steps = this.ir.steps;
		const exit = (): void => this.stop();
		// Listeners attached right after start() must see the first events, even when the run fails synchronously.
		await Promise.resolve();
		this.emit('journey:start', { from });
		let acted = resume.acted === true;
		let navigated = resume.navigated === true;
		let lastAction: Interaction['kind'] | null = null;
		try {
			for (const step of steps.slice(0, from)) {
				if (!isMaskedFill(step)) continue;
				try {
					this.keepMasked(step, this.stepParams(step), null);
				} catch {}
			}
			for (let i = from; i < steps.length; i++) {
				const step = steps[i] as IRStep;
				this.index = i;
				const stepData = { stepId: step.id, index: i };
				if (this.shouldSkip(step)) {
					this.emit('step:skip', { ...stepData, reason: 'when' });
					continue;
				}
				const detach = this.listenEvents(step);
				const nextDeferred = deferred();
				const acting = presenterOf(step);
				if (acting !== visible) {
					visible.hide();
					visible = acting;
				}
				const ctx: ActorCtx = {
					signal: this.signal,
					next: nextDeferred.promise,
					presenter: acting,
					params: this.deps.params,
					exit,
					proceed: nextDeferred.resolve,
					markActed: () => progress?.save(i, true),
					navigate: this.deps.navigate,
				};
				try {
					this.emit('step:start', stepData);
					const params = this.stepParams(step);
					const action = this.resolveAction(step);
					const showCtx: ShowCtx = {
						index: i,
						total: steps.length,
						title: this.text(step.say?.title),
						body: this.text(step.say?.body),
						action,
						human: actor.human === true,
						stepped: actor.stepped === true,
						next: step.guide === 'next' || actor.stepped ? nextDeferred.resolve : null,
						exit,
					};
					if (!acted) {
						if (step.route !== undefined && !matchesRoute(step.route)) {
							const route = step.route;
							const onRoute = (): true | undefined => (matchesRoute(route) ? true : undefined);
							const inFlight = lastAction !== null && lastAction !== 'none';
							const settled = inFlight ? await this.poll(onRoute, step.timeout) : undefined;
							if (settled !== true) {
								if (navigated)
									throw new Error(`route ${route}: ${currentUrl(route)} after navigating`);
								navigated = true;
								progress?.save(i, false, true);
								await this.race(actor.navigate(route, ctx));
								const arrived = await this.poll(onRoute, actor.human ? null : step.timeout);
								if (arrived !== true) throw new Error(`route ${route}: ${currentUrl(route)}`);
							}
						}
						progress?.save(i, false);
						if (!scripted && step.target !== undefined) {
							acting.show(step, null, { ...showCtx, next: null });
						}
						let el = await this.resolveTarget(step, params);
						for (;;) {
							this.emit('step:resolved', { ...stepData, target: step.target ?? null });
							acting.show(step, el, showCtx);
							this.keepMasked(step, params, el);
							this.applyMasks(params);
							await sleep(paceOf(step, 'beforeAction'), this.signal);
							if (el && acting.moveCursor) {
								await this.within('presenter moveCursor', acting.moveCursor(el), step.timeout);
							}
							const onEl = action.kind !== 'none' && action.kind !== 'navigate';
							const watch = el && onEl && actor.human ? this.watchDetach(el) : null;
							try {
								await this.race(
									actor.perform(step, el, action, watch ? { ...ctx, signal: watch.signal } : ctx),
								);
							} finally {
								watch?.stop();
							}
							if (!watch?.detached()) break;
							el = await this.resolveTarget(step, params);
						}
						if (el && (action.kind === 'click' || action.kind === 'dblclick')) acting.ripple?.(el);
						this.emit('step:acted', { ...stepData, action: redacted(step, action) });
						progress?.save(i, true);
					} else {
						acted = false;
						const found =
							step.target === undefined ? null : (resolveOne(step.target, params).el ?? null);
						acting.show(step, found, { ...showCtx, next: null });
						this.keepMasked(step, params, found);
						this.applyMasks(params);
						if (actor.resume) await this.race(actor.resume(step, ctx));
					}
					await this.waitExpectations(step, params);
					await this.within('presenter settle', acting.settle(step), step.timeout);
					await sleep(paceOf(step, 'afterSettle'), this.signal);
					this.applyMasks(params);
					result.completed += 1;
					lastAction = step.do.kind;
					navigated = false;
					const capture: Capture | null = step.capture ?? null;
					this.emit('step:pass', { ...stepData, capture });
					progress?.save(i + 1, false);
					if (actor.afterStep) await this.race(actor.afterStep(step, i, ctx));
				} catch (error) {
					if (error instanceof StepSkip) {
						this.emit('step:skip', { ...stepData, reason: error.message });
						continue;
					}
					throw error;
				} finally {
					detach();
				}
			}
			this.emit('journey:done', { completed: result.completed });
			progress?.clear();
		} catch (error) {
			const step = steps[this.index];
			if (error instanceof AbortError || this.aborted) {
				result.ok = false;
				result.aborted = true;
				this.emit('journey:abort', { index: this.index, exit: this.exitRequested });
				progress?.clear();
			} else {
				const message = error instanceof Error ? error.message : String(error);
				result.ok = false;
				result.failures.push({ stepId: step?.id ?? '', error: message });
				this.emit('step:fail', { stepId: step?.id ?? '', index: this.index, error: message });
				this.emit('journey:done', { completed: result.completed, ok: false });
				progress?.clear();
			}
		} finally {
			if (!this.deps.mask) this.masker.clear();
			visible.hide();
			this.running = false;
		}
		return result;
	}
}

export { isParamRef };
