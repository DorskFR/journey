import { compile, dropLine, publicDrops } from '../core/compile.js';
import type { IR, Journey, PresenterName, Text } from '../core/types.js';
import { VERSION } from '../version.js';
import { domActor, humanActor, steppedActor } from './actors.js';
import { createDriver, MODE as DRIVER_MODE, type Driver } from './driver.js';
import {
	type Actor,
	Engine,
	matchesUrl,
	type NavigateHook,
	type Presenter,
	type RunResult,
} from './engine.js';
import { createOverlay, type Overlay, type Placement } from './overlay.js';
import { docPresenter, guidePresenter, nonePresenter, spotPresenter } from './presenters.js';
import { clearProgress, readProgress, storedParams, writeProgress } from './progress.js';
import {
	accessibleName,
	computedRole,
	isVisible,
	resolveAll,
	resolveOne,
	resolvePath,
} from './resolve.js';
import { detectVariant, watchRoute } from './route.js';
import { defaultStorage, type JourneyStorage } from './storage.js';
import {
	type Localize,
	resolveStrings,
	type Strings,
	type StringsOption,
	translator,
} from './strings.js';
import {
	currentLocale,
	isParamRef,
	type Params,
	planParams,
	resolveStepParams,
	resolveText,
} from './text.js';

export * from './actors.js';
export * from './driver.js';
export * from './engine.js';
export * from './mask.js';
export * from './overlay.js';
export * from './presenters.js';
export * from './progress.js';
export * from './resolve.js';
export * from './route.js';
export * from './storage.js';
export * from './strings.js';
export * from './text.js';

export type Mode = 'guide' | 'preview' | 'run';

export interface MountOptions {
	journeys?: Journey[] | (() => Promise<{ default?: Journey[] } | Journey[]>);
	editor?: boolean;
	translate?: (id: string, locale: string) => string | undefined;
	probes?: Record<string, () => unknown | Promise<unknown>>;
	variants?: Record<string, (value: string) => void | Promise<void>>;
	track?: (event: string, data: Record<string, unknown>) => void;
	exportUrl?: string;
	launcher?: boolean;
	strings?: StringsOption;
	navigate?: NavigateHook;
	storage?: JourneyStorage;
	presenter?: Presenter | ((name: PresenterName) => Presenter);
	placement?: Placement;
	params?: Params | ((id: string) => Params | undefined);
	variant?: Record<string, string> | (() => Record<string, string>);
}

export interface StartOptions {
	mode?: Mode;
	from?: number;
	params?: Params;
	variant?: Record<string, string>;
}

export interface RegisterOptions {
	params?: Params;
}

export interface RegisterResult {
	registered: string[];
	rejected: Array<{ index: number; id?: string; error: string }>;
}

export const resolve = {
	resolveOne,
	resolveAll,
	resolvePath,
	accessibleName,
	computedRole,
	isVisible,
	resolveStepParams,
};

export interface JourneyApi {
	resolve: typeof resolve;
	register(journeys: Journey[], opts?: RegisterOptions): Promise<RegisterResult>;
	list(): Array<{ id: string; title?: string; version: number }>;
	start(id: string, opts?: StartOptions): Promise<RunResult>;
	stop(): void;
	current(): { id: string; index: number } | null;
	applyVariant(dim: string, value: string): Promise<void>;
	translate(text: Text, locale?: string): string;
	strings(): Strings;
	driver: Driver;
	overlay: Overlay;
	version: string;
	options: MountOptions;
	engine(): Engine | null;
	unmount(): void;
}

declare global {
	interface Window {
		__journey?: JourneyApi;
		journeyEditor?: { mountEditor(api: JourneyApi): void };
	}
}

export const DEFAULT_VARIANT: Record<string, string> = { viewport: 'desktop' };

function doneKey(ir: IR): string {
	return `journey:done:${ir.id}@${ir.version}`;
}

function localized(actor: Actor, t: Localize): Actor {
	return {
		...actor,
		navigate(route, ctx) {
			const presenter: Presenter = {
				...ctx.presenter,
				message: (_title, _body, exit, next) =>
					ctx.presenter.message?.(
						t('goToPage'),
						t('goToPageBody', { route }),
						exit,
						next,
						next ? t('goToPageAction') : undefined,
					),
			};
			return actor.navigate(route, { ...ctx, presenter });
		},
	};
}

// A param the user types in guide mode reads back whatever the field holds.
function asking(actor: Actor, ask: Set<string>, params: Params): Actor {
	if (ask.size === 0) return actor;
	return {
		...actor,
		perform(step, el, action, ctx) {
			const ref = step.do.kind === 'fill' || step.do.kind === 'select' ? step.do.value : undefined;
			if (!el || !isParamRef(ref) || !ask.has(ref.$param)) {
				return actor.perform(step, el, action, ctx);
			}
			const field = el as HTMLInputElement;
			Object.defineProperty(params, ref.$param, {
				get: () => field.value,
				enumerable: true,
				configurable: true,
			});
			const typed =
				action.kind === 'fill' || action.kind === 'select'
					? { ...action, value: field.value }
					: action;
			return actor.perform(step, el, typed, ctx);
		},
	};
}

function onReady(fn: () => void): void {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', fn, { once: true });
	} else {
		fn();
	}
}

let active: { api: JourneyApi; apply(options: MountOptions): void } | null = null;

export function mount(input: MountOptions = {}): JourneyApi {
	if (window.__journey) {
		if (active?.api === window.__journey) active.apply(input);
		else if (Object.keys(input).length > 0) {
			console.warn('journey: another runtime is mounted; unmount it to apply these options');
		}
		return window.__journey;
	}

	const options: MountOptions = { ...input };
	const journeys = new Map<string, IR>();
	const store = (): JourneyStorage => options.storage ?? defaultStorage;
	const overlay = createOverlay();
	let mounted = true;
	let launcherShown = false;
	let settling: Promise<unknown> = Promise.resolve();
	let engine: Engine | null = null;
	let currentId: string | null = null;
	let currentVariant: Record<string, string> = DEFAULT_VARIANT;

	const translate = (text: Text, locale?: string): string =>
		resolveText(text, options.translate, locale ?? currentLocale()) ?? '';
	const strings = (): Strings => resolveStrings(options.strings, currentLocale(currentVariant));
	const t = translator(strings);

	const builtin = (name: PresenterName): Presenter => {
		if (name === 'doc') return docPresenter(overlay, t);
		if (name === 'spot') return spotPresenter(overlay, t);
		if (name === 'guide') return guidePresenter(overlay, t);
		return nonePresenter;
	};
	const presenterFor = (name: PresenterName): Presenter => {
		const custom = options.presenter;
		if (typeof custom === 'function') return custom(name);
		if (custom && name !== 'none') return custom;
		return builtin(name);
	};
	const mountParams = (id: string): Params => {
		const given = options.params;
		return { ...(typeof given === 'function' ? given(id) : given) };
	};

	if (options.placement) overlay.placement = options.placement;

	const driver = createDriver({
		presenter: presenterFor,
		place: (placement) => {
			overlay.placement = options.placement ?? placement;
		},
		get translate() {
			return options.translate;
		},
		get probes() {
			return options.probes;
		},
		get track() {
			return options.track;
		},
		onEngine(e) {
			engine = e;
			currentId = e ? e.ir.id : null;
		},
	});

	async function startRun(
		id: string,
		opts: StartOptions,
		resume: { acted: boolean; navigated: boolean },
	): Promise<RunResult> {
		const ir = journeys.get(id);
		if (!ir) throw new Error(`journey "${id}" is not registered`);
		if (engine) engine.stop();
		const mode: Mode = opts.mode ?? 'guide';
		const given = options.variant;
		const variant = {
			...DEFAULT_VARIANT,
			...detectVariant(),
			...(typeof given === 'function' ? given() : given),
			...opts.variant,
		};
		currentVariant = variant;
		const params: Params = { ...mountParams(id), ...opts.params };
		for (const [dim, value] of Object.entries(variant)) params[`variant.${dim}`] = value;
		const stored = storedParams(ir, params);
		const from = opts.from ?? 0;
		const plan = planParams(ir, params, { from, variant, human: mode === 'guide' });
		if (plan.missing) {
			const { stepId, param } = plan.missing;
			const error = `missing param "${param}": pass it in start("${id}", { params }) or mount({ params })`;
			console.error(`journey: ${id}: ${error}`);
			if (from > 0) await clearProgress(store());
			return { ok: false, completed: 0, failures: [{ stepId, error }] };
		}
		for (const name of plan.ask) params[name] = '';
		const actor =
			mode === 'guide'
				? localized(humanActor, t)
				: mode === 'preview'
					? localized(steppedActor, t)
					: domActor;
		const run = new Engine(ir, {
			actor: asking(actor, new Set(plan.ask), params),
			presenter: presenterFor(mode === 'run' ? 'none' : 'guide'),
			presenterFor,
			params,
			variant,
			translate: options.translate,
			probes: options.probes,
			track: options.track,
			navigate: options.navigate,
			progress: {
				save(index, acted, navigated) {
					void writeProgress(
						{
							id,
							version: ir.version,
							index,
							mode,
							params: stored,
							variant,
							acted,
							navigated,
						},
						store(),
					);
				},
				clear: () => void clearProgress(store()),
			},
		});
		engine = run;
		currentId = id;
		const seen = (): void => {
			if (mounted && ir.autostart?.once) void store().set(doneKey(ir), '1');
		};
		run.on('journey:done', (data) => {
			if (data.ok !== false) seen();
		});
		run.on('journey:abort', (data) => {
			if (data.exit === true) seen();
		});
		const running = run.run(from, resume);
		settling = running;
		try {
			return await running;
		} finally {
			if (engine === run) {
				engine = null;
				currentId = null;
			}
		}
	}

	function start(id: string, opts: StartOptions = {}): Promise<RunResult> {
		return startRun(id, opts, { acted: false, navigated: false });
	}

	async function resume(supplied: Params | undefined): Promise<void> {
		const progress = await readProgress(store());
		if (!mounted || !progress || progress.mode === DRIVER_MODE || engine) return;
		const ir = journeys.get(progress.id);
		if (!ir || ir.version !== progress.version) return;
		const from = progress.index;
		if (from >= ir.steps.length) {
			await clearProgress(store());
			return;
		}
		void startRun(
			progress.id,
			{
				mode: progress.mode as Mode,
				from,
				params: { ...progress.params, ...supplied },
				variant: progress.variant,
			},
			{ acted: progress.acted === true, navigated: progress.navigated === true },
		).catch(() => {});
	}

	let autostarting: Promise<void> = Promise.resolve();
	function autostart(): Promise<void> {
		autostarting = autostarting.then(async () => {
			if (!mounted || engine) return;
			for (const ir of journeys.values()) {
				const auto = ir.autostart;
				if (!auto || !matchesUrl(auto.route)) continue;
				if (auto.once && ((await store().get(doneKey(ir))) ?? null) !== null) continue;
				if (!mounted || engine || !matchesUrl(auto.route)) return;
				void start(ir.id, { mode: 'guide' }).catch(() => {});
				return;
			}
		});
		return autostarting;
	}

	function register(list: Journey[], opts: RegisterOptions = {}): Promise<RegisterResult> {
		const result: RegisterResult = { registered: [], rejected: [] };
		list.forEach((journey, index) => {
			try {
				const ir = compile(journey, { public: true });
				const dropped = dropLine(ir.id, publicDrops(journey));
				if (dropped) console.info(dropped);
				journeys.set(ir.id, ir);
				result.registered.push(ir.id);
			} catch (error) {
				const raw = (journey as { id?: unknown } | null)?.id;
				const id = typeof raw === 'string' ? raw : undefined;
				const message = error instanceof Error ? error.message : String(error);
				if (id !== undefined) journeys.delete(id);
				console.error(`journey: skipped ${id ?? `journeys[${index}]`}: ${message}`);
				result.rejected.push({ index, id, error: message });
			}
		});
		return new Promise<RegisterResult>((settled) => {
			onReady(() => {
				void (async () => {
					await resume(opts.params);
					await autostart();
					renderLauncher();
					settled(result);
				})();
			});
		});
	}

	function renderLauncher(): void {
		if (!mounted || (!options.launcher && !launcherShown)) return;
		const launcher = overlay.parts.launcher;
		launcher.replaceChildren();
		launcherShown = options.launcher === true;
		if (!launcherShown) {
			launcher.hidden = true;
			return;
		}
		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.textContent = 'Journeys';
		toggle.setAttribute('aria-expanded', 'false');
		const ul = document.createElement('ul');
		ul.hidden = true;
		for (const ir of journeys.values()) {
			const li = document.createElement('li');
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = ir.title === undefined ? ir.id : translate(ir.title);
			button.addEventListener('click', () => {
				ul.hidden = true;
				toggle.setAttribute('aria-expanded', 'false');
				void start(ir.id).catch(() => {});
			});
			li.append(button);
			ul.append(li);
		}
		toggle.addEventListener('click', () => {
			ul.hidden = !ul.hidden;
			toggle.setAttribute('aria-expanded', String(!ul.hidden));
		});
		launcher.append(ul, toggle);
		launcher.hidden = false;
	}

	const onClick = (event: MouseEvent): void => {
		const origin = event.target instanceof Element ? event.target : null;
		const trigger = origin?.closest('[data-journey-start]');
		const id = trigger?.getAttribute('data-journey-start');
		if (id) void start(id).catch(() => {});
	};

	function load(initial: MountOptions['journeys']): void {
		if (Array.isArray(initial)) {
			void register(initial);
		} else if (typeof initial === 'function') {
			void initial()
				.then((loaded) => {
					if (mounted) return register(Array.isArray(loaded) ? loaded : (loaded.default ?? []));
				})
				.catch((error) => console.error('journey: failed to load journeys', error));
		}
	}

	function unmount(): void {
		if (!mounted) return;
		mounted = false;
		engine?.stop();
		document.removeEventListener('click', onClick);
		unwatchRoute();
		overlay.remove();
		void settling.finally(() => overlay.remove());
		journeys.clear();
		if (window.__journey === api) delete window.__journey;
		if (active?.api === api) active = null;
	}

	const api: JourneyApi = {
		resolve,
		register,
		list() {
			return Array.from(journeys.values(), (ir) => ({
				id: ir.id,
				title: ir.title === undefined ? undefined : translate(ir.title),
				version: ir.version,
			}));
		},
		start,
		stop() {
			engine?.stop();
		},
		current() {
			return engine && currentId !== null
				? { id: currentId, index: Math.max(0, engine.index) }
				: null;
		},
		async applyVariant(dim, value) {
			const handler = options.variants?.[dim];
			if (handler) {
				await handler(value);
				return;
			}
			document.documentElement.dataset[dim] = value;
			console.warn(`journey: no variant handler for "${dim}", set data-${dim}="${value}"`);
		},
		translate,
		strings,
		driver,
		overlay,
		version: VERSION,
		options,
		engine: () => engine,
		unmount,
	};
	window.__journey = api;
	active = {
		api,
		apply(next) {
			const editor = options.editor;
			Object.assign(options, next);
			if ('placement' in next) overlay.placement = options.placement ?? overlay.placement;
			if ('launcher' in next) onReady(renderLauncher);
			if (options.editor && !editor) {
				onReady(() => {
					if (mounted) window.journeyEditor?.mountEditor(api);
				});
			}
			load(next.journeys);
		},
	};

	document.addEventListener('click', onClick);
	const unwatchRoute = watchRoute(() => void autostart());

	onReady(() => {
		if (mounted && options.editor) window.journeyEditor?.mountEditor(api);
	});

	load(options.journeys);
	return api;
}
