import type { Capture, Interaction, IR } from '../core/types.js';
import { DriverActor, type DriverYield } from './actors.js';
import { Engine, type Pace, type Presenter, type RunResult } from './engine.js';
import { clearProgress, readProgress, writeProgress } from './progress.js';
import type { Params, Translate } from './text.js';

export interface LoadOptions {
	params: Params;
	variant: Record<string, string>;
	presenter: 'none' | 'doc' | 'guide';
	mask?: boolean;
	masks?: string[];
	pace?: Pace;
	from?: number;
}

export type StepResult =
	| { done: true; result: RunResult }
	| { done: false; stepId: string; index: number; route: string }
	| {
			done: false;
			stepId: string;
			index: number;
			action: Interaction | null;
			marker: string | null;
	  };

export interface SettleResult {
	ok: boolean;
	error?: string;
	capture: Capture | null;
	index: number;
	stepId: string;
}

export interface Driver {
	load(ir: IR, opts: LoadOptions): Promise<{ resumedAt: number | null }>;
	step(): Promise<StepResult>;
	acted(): Promise<void>;
	settle(): Promise<SettleResult>;
}

export interface DriverHost {
	presenter(name: LoadOptions['presenter']): Presenter;
	translate?: Translate;
	probes?: Record<string, () => unknown | Promise<unknown>>;
	track?: (event: string, data: Record<string, unknown>) => void;
	onEngine?(engine: Engine | null): void;
}

interface Session {
	engine: Engine;
	actor: DriverActor;
	run: Promise<RunResult> | null;
	result: RunResult | null;
	from: number;
	acted: boolean;
	navigated: boolean;
	yielded: DriverYield | null;
	settled: SettleResult | null;
	awaitingSettle: boolean;
	waiters: {
		step: ((r: StepResult) => void) | null;
		settle: ((r: SettleResult) => void) | null;
	};
}

export const MODE = 'driver';

export function createDriver(host: DriverHost): Driver {
	let session: Session | null = null;

	function fail(message: string): Promise<never> {
		return Promise.reject(new Error(`journey driver: ${message}`));
	}

	function deliverStep(s: Session): void {
		const waiter = s.waiters.step;
		if (!waiter) return;
		if (s.result) {
			s.waiters.step = null;
			waiter({ done: true, result: s.result });
			return;
		}
		const y = s.yielded;
		if (!y) return;
		s.waiters.step = null;
		s.yielded = null;
		const index = s.engine.index;
		if (y.route !== undefined) {
			waiter({ done: false, stepId: s.engine.ir.steps[index]?.id ?? '', index, route: y.route });
			return;
		}
		s.awaitingSettle = true;
		waiter({
			done: false,
			stepId: y.stepId,
			index,
			action: y.action ?? null,
			marker: y.marker ?? null,
		});
	}

	function deliverSettle(s: Session): void {
		const waiter = s.waiters.settle;
		if (!waiter || !s.settled) return;
		s.waiters.settle = null;
		const settled = s.settled;
		s.settled = null;
		waiter(settled);
	}

	return {
		async load(ir, opts) {
			if (session) {
				session.engine.stop();
				host.onEngine?.(null);
			}
			const progress = readProgress();
			const resumed =
				progress &&
				progress.id === ir.id &&
				progress.version === ir.version &&
				progress.mode === MODE
					? progress
					: null;
			const from = resumed ? resumed.index : (opts.from ?? 0);
			const actor = new DriverActor();
			const engine = new Engine(ir, {
				actor,
				presenter: host.presenter(opts.presenter),
				params: opts.params,
				variant: opts.variant,
				translate: host.translate,
				probes: host.probes,
				pace: opts.pace,
				mask: opts.mask,
				masks: opts.masks,
				track: host.track,
				progress: {
					save(index, acted, navigated) {
						writeProgress({
							id: ir.id,
							version: ir.version,
							index,
							mode: MODE,
							params: opts.params,
							variant: opts.variant,
							ir,
							acted,
							navigated,
						});
					},
					clear: clearProgress,
				},
			});
			const s: Session = {
				engine,
				actor,
				run: null,
				result: null,
				from,
				acted: resumed?.acted === true,
				navigated: resumed?.navigated === true,
				yielded: null,
				settled: null,
				awaitingSettle: false,
				waiters: { step: null, settle: null },
			};
			actor.onYield = (y) => {
				s.yielded = y;
				deliverStep(s);
			};
			const settle = (data: Record<string, unknown>, ok: boolean): void => {
				if (!s.awaitingSettle) return;
				s.awaitingSettle = false;
				s.settled = {
					ok,
					...(ok ? {} : { error: String(data.error) }),
					capture: ok ? ((data.capture as Capture | null) ?? null) : null,
					index: data.index as number,
					stepId: data.stepId as string,
				};
				deliverSettle(s);
			};
			engine.on('step:pass', (data) => settle(data, true));
			engine.on('step:fail', (data) => settle(data, false));
			session = s;
			host.onEngine?.(engine);
			return { resumedAt: resumed ? from : null };
		},

		step() {
			const s = session;
			if (!s) return fail('call load() before step()');
			if (s.waiters.step) return fail('step() is already pending');
			if (s.actor.pending && s.actor.pending.route === undefined) {
				return fail('call acted() and settle() before the next step()');
			}
			if (s.awaitingSettle) return fail('call settle() before the next step()');
			if (s.result) return Promise.resolve({ done: true, result: s.result });
			if (!s.run) {
				s.run = s.engine.run(s.from, { acted: s.acted, navigated: s.navigated }).then((result) => {
					s.result = result;
					host.onEngine?.(null);
					deliverStep(s);
					return result;
				});
			} else {
				s.actor.proceed();
			}
			return new Promise<StepResult>((resolve) => {
				s.waiters.step = resolve;
				deliverStep(s);
			});
		},

		async acted() {
			const s = session;
			if (!s) return fail('call load() before acted()');
			const pending = s.actor.pending;
			if (!pending || pending.route !== undefined)
				return fail('acted() called without a pending action');
			s.actor.acted();
		},

		settle() {
			const s = session;
			if (!s) return fail('call load() before settle()');
			if (s.waiters.settle) return fail('settle() is already pending');
			if (s.actor.pending && s.actor.pending.action === null) s.actor.acted();
			if (s.actor.pending) return fail('call acted() before settle()');
			if (!s.awaitingSettle && !s.settled) return fail('settle() called without a pending step');
			return new Promise<SettleResult>((resolve) => {
				s.waiters.settle = resolve;
				deliverSettle(s);
			});
		},
	};
}
