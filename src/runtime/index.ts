import { compile } from '../core/compile.js';
import type { IR, Journey, Text } from '../core/types.js';
import { VERSION } from '../version.js';
import { domActor, humanActor, steppedActor } from './actors.js';
import { createDriver, MODE as DRIVER_MODE, type Driver } from './driver.js';
import { type Actor, Engine, type Presenter, type RunResult } from './engine.js';
import { createOverlay, type Overlay } from './overlay.js';
import { docPresenter, guidePresenter, nonePresenter } from './presenters.js';
import { clearProgress, readProgress, writeProgress } from './progress.js';
import {
	accessibleName,
	computedRole,
	isVisible,
	resolveAll,
	resolveOne,
	resolvePath,
} from './resolve.js';
import {
	type Localize,
	resolveStrings,
	type Strings,
	type StringsOption,
	translator,
} from './strings.js';
import { currentLocale, type Params, resolveStepParams, resolveText } from './text.js';

export * from './actors.js';
export * from './driver.js';
export * from './engine.js';
export * from './mask.js';
export * from './overlay.js';
export * from './presenters.js';
export * from './progress.js';
export * from './resolve.js';
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
}

export interface StartOptions {
	mode?: Mode;
	from?: number;
	params?: Params;
	variant?: Record<string, string>;
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
	register(journeys: Journey[]): void;
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
					ctx.presenter.message?.(t('goToPage'), t('goToPageBody', { route }), exit, next),
			};
			return actor.navigate(route, { ...ctx, presenter });
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

export function mount(options: MountOptions = {}): JourneyApi {
	if (window.__journey) return window.__journey;

	const journeys = new Map<string, IR>();
	const overlay = createOverlay();
	let engine: Engine | null = null;
	let currentId: string | null = null;
	let currentVariant: Record<string, string> = DEFAULT_VARIANT;

	const translate = (text: Text, locale?: string): string =>
		resolveText(text, options.translate, locale ?? currentLocale()) ?? '';
	const strings = (): Strings => resolveStrings(options.strings, currentLocale(currentVariant));
	const t = translator(strings);

	const presenterFor = (name: 'none' | 'doc' | 'guide'): Presenter => {
		if (name === 'doc') return docPresenter(overlay, t);
		if (name === 'guide') return guidePresenter(overlay, t);
		return nonePresenter;
	};

	const driver = createDriver({
		presenter: presenterFor,
		translate: options.translate,
		probes: options.probes,
		track: options.track,
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
		const variant = { ...DEFAULT_VARIANT, ...opts.variant };
		currentVariant = variant;
		const params: Params = { ...opts.params };
		for (const [dim, value] of Object.entries(variant)) params[`variant.${dim}`] = value;
		const run = new Engine(ir, {
			actor:
				mode === 'guide'
					? localized(humanActor, t)
					: mode === 'preview'
						? localized(steppedActor, t)
						: domActor,
			presenter: mode === 'run' ? nonePresenter : guidePresenter(overlay, t),
			params,
			variant,
			translate: options.translate,
			probes: options.probes,
			track: options.track,
			progress: {
				save(index, acted, navigated) {
					writeProgress({
						id,
						version: ir.version,
						index,
						mode,
						params,
						variant,
						ir,
						acted,
						navigated,
					});
				},
				clear: clearProgress,
			},
		});
		engine = run;
		currentId = id;
		run.on('journey:done', () => {
			if (ir.autostart?.once) localStorage.setItem(doneKey(ir), '1');
		});
		try {
			return await run.run(opts.from ?? 0, resume);
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

	function resume(): void {
		const progress = readProgress();
		if (!progress || progress.mode === DRIVER_MODE || engine) return;
		const ir = journeys.get(progress.id);
		if (!ir || ir.version !== progress.version) return;
		const from = progress.index;
		if (from >= ir.steps.length) {
			clearProgress();
			return;
		}
		void startRun(
			progress.id,
			{ mode: progress.mode as Mode, from, params: progress.params, variant: progress.variant },
			{ acted: progress.acted === true, navigated: progress.navigated === true },
		).catch(() => {});
	}

	function autostart(): void {
		if (engine) return;
		for (const ir of journeys.values()) {
			const auto = ir.autostart;
			if (!auto || location.pathname !== auto.route) continue;
			if (auto.once && localStorage.getItem(doneKey(ir))) continue;
			void start(ir.id, { mode: 'guide' }).catch(() => {});
			return;
		}
	}

	function register(list: Journey[]): void {
		for (const journey of list) {
			const ir = compile(journey);
			journeys.set(ir.id, ir);
		}
		onReady(() => {
			resume();
			autostart();
			renderLauncher();
		});
	}

	function renderLauncher(): void {
		if (!options.launcher) return;
		const launcher = overlay.parts.launcher;
		launcher.replaceChildren();
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
	};
	window.__journey = api;

	document.addEventListener('click', (event) => {
		const origin = event.target instanceof Element ? event.target : null;
		const trigger = origin?.closest('[data-journey-start]');
		const id = trigger?.getAttribute('data-journey-start');
		if (id) void start(id).catch(() => {});
	});

	onReady(() => {
		if (options.editor) window.journeyEditor?.mountEditor(api);
	});

	const initial = options.journeys;
	if (Array.isArray(initial)) {
		register(initial);
	} else if (typeof initial === 'function') {
		void initial()
			.then((loaded) => register(Array.isArray(loaded) ? loaded : (loaded.default ?? [])))
			.catch((error) => console.error('journey: failed to load journeys', error));
	}
	return api;
}
