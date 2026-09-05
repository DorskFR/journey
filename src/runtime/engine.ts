import type { Capture, Expectation, Interaction, IR, IRStep, Target } from '../core/types.js';
import { Masker } from './mask.js';
import { describeTarget, resolveAll, resolveOne } from './resolve.js';
import {
	currentLocale,
	isParamRef,
	type Params,
	resolveParam,
	resolveStepParams,
	resolveText,
	type Translate,
} from './text.js';

export interface Pace {
	beforeAction?: number;
	afterSettle?: number;
}

export interface RunResult {
	ok: boolean;
	completed: number;
	failures: Array<{ stepId: string; error: string }>;
	aborted?: boolean;
}

export interface ActorCtx {
	signal: AbortSignal;
	next: Promise<void>;
	presenter: Presenter;
	params: Params;
	exit: () => void;
	markActed: () => void;
}

export interface Actor {
	human?: boolean;
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
	next: (() => void) | null;
	exit: () => void;
}

export interface Presenter {
	show(step: IRStep, el: Element | null, ctx: ShowCtx): void;
	settle(step: IRStep): void | Promise<void>;
	hide(): void;
	message?(title: string, body: string, exit: () => void): void;
	moveCursor?(el: Element): Promise<void>;
	ripple?(el: Element): void;
}

export interface ProgressSink {
	save(index: number, acted: boolean): void;
	clear(): void;
}

export interface EngineDeps {
	actor: Actor;
	presenter: Presenter;
	params: Params;
	variant: Record<string, string>;
	translate?: Translate;
	probes?: Record<string, () => unknown | Promise<unknown>>;
	pace?: Pace;
	mask?: boolean;
	masks?: string[];
	track?: (event: string, data: Record<string, unknown>) => void;
	progress?: ProgressSink;
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

export function matchesRoute(route: string): boolean {
	const current = route.includes('#') ? location.pathname + location.hash : location.pathname;
	return current === route;
}

export function matchesUrl(pattern: string): boolean {
	const current = pattern.includes('#') ? location.pathname + location.hash : location.pathname;
	if (!pattern.includes('*')) return current === pattern;
	const source = pattern
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

function currentUrl(pattern: string): string {
	return pattern.includes('#') ? location.pathname + location.hash : location.pathname;
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

	private async poll<T>(
		fn: () => T | undefined | Promise<T | undefined>,
		timeout: number | null,
	): Promise<T | undefined> {
		const deadline = timeout === null ? Number.POSITIVE_INFINITY : Date.now() + timeout;
		for (;;) {
			if (this.aborted) throw new AbortError();
			const value = await fn();
			if (value !== undefined) return value;
			if (Date.now() >= deadline) return undefined;
			await sleep(POLL_INTERVAL, this.signal);
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

	private async checkExpectation(e: Expectation, params: Params): Promise<string | null> {
		const single = (target: Target, label: string) => {
			const r = resolveOne(target, params);
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
			const r = single(target, 'value');
			if (r.error !== undefined) return r.error;
			const actual = elementValue(r.el);
			return actual === expected
				? null
				: `value ${describeTarget(target)} ${JSON.stringify(expected)}: ${JSON.stringify(actual)}`;
		}
		if ('checked' in e) {
			const [target, expected] = e.checked;
			const r = single(target, 'checked');
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
		const observed = await probe();
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
		const passed = await this.poll(async () => {
			for (const e of expectations) {
				const error = await this.checkExpectation(e, params);
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
		if (!this.deps.mask) return;
		this.masker.apply([...(this.ir.mask ?? []), ...(this.deps.masks ?? [])], params);
	}

	private async resolveTarget(step: IRStep, params: Params): Promise<Element | null> {
		if (step.target === undefined) return null;
		const target = step.target;
		const timeout = this.deps.actor.human ? null : step.timeout;
		const found = await this.poll<{ el: Element } | { count: number }>(() => {
			const r = resolveOne(target, params);
			if (r.error === undefined) return { el: r.el };
			if (r.error === 'ambiguous') return { count: r.count };
			return undefined;
		}, timeout);
		if (found === undefined) {
			if (step.optional) throw new StepSkip(`target ${describeTarget(target)} not found`);
			throw new Error(`target ${describeTarget(target)}: 0 matches after ${step.timeout}ms`);
		}
		if ('count' in found) {
			throw new Error(`target ${describeTarget(target)}: ambiguous, ${found.count} matches`);
		}
		return found.el;
	}

	private shouldSkip(step: IRStep): boolean {
		return Object.entries(step.when ?? {}).some(([dim, value]) => this.deps.variant[dim] !== value);
	}

	async run(from = 0, resume: { acted?: boolean } = {}): Promise<RunResult> {
		if (this.running) throw new Error('Engine is already running');
		this.running = true;
		this.exitRequested = false;
		this.controller = new AbortController();
		const { actor, presenter, pace, progress } = this.deps;
		const result: RunResult = { ok: true, completed: 0, failures: [] };
		const steps = this.ir.steps;
		const exit = (): void => this.stop();
		this.emit('journey:start', { from });
		let acted = resume.acted === true;
		try {
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
				const ctx: ActorCtx = {
					signal: this.signal,
					next: nextDeferred.promise,
					presenter,
					params: this.deps.params,
					exit,
					markActed: () => progress?.save(i, true),
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
						next: step.guide === 'next' ? nextDeferred.resolve : null,
						exit,
					};
					if (!acted) {
						if (step.route !== undefined && !matchesRoute(step.route)) {
							progress?.save(i, false);
							await this.race(actor.navigate(step.route, ctx));
							const route = step.route;
							const arrived = await this.poll(
								() => (matchesRoute(route) ? true : undefined),
								actor.human ? null : step.timeout,
							);
							if (arrived !== true) throw new Error(`route ${route}: ${currentUrl(route)}`);
						}
						progress?.save(i, false);
						const el = await this.resolveTarget(step, params);
						this.emit('step:resolved', { ...stepData, target: step.target ?? null });
						presenter.show(step, el, showCtx);
						this.applyMasks(params);
						await sleep(pace?.beforeAction ?? 0, this.signal);
						if (el && presenter.moveCursor) await this.race(presenter.moveCursor(el));
						await this.race(actor.perform(step, el, action, ctx));
						if (el && (action.kind === 'click' || action.kind === 'dblclick'))
							presenter.ripple?.(el);
						this.emit('step:acted', { ...stepData, action });
						progress?.save(i, true);
					} else {
						acted = false;
						const found =
							step.target === undefined ? null : (resolveOne(step.target, params).el ?? null);
						presenter.show(step, found, { ...showCtx, next: null });
						this.applyMasks(params);
						if (actor.resume) await this.race(actor.resume(step, ctx));
					}
					await this.waitExpectations(step, params);
					await this.race(Promise.resolve(presenter.settle(step)));
					await sleep(pace?.afterSettle ?? 0, this.signal);
					result.completed += 1;
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
			this.masker.clear();
			presenter.hide();
			this.running = false;
		}
		return result;
	}
}

export { isParamRef };
