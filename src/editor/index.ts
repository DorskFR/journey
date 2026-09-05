import type { Expectation, Interaction, Journey, Target } from '../core/types.js';
import { validate } from '../core/validate.js';
import type { Engine } from '../runtime/engine.js';
import type { JourneyApi } from '../runtime/index.js';
import { readProgress } from '../runtime/progress.js';
import { type Digest, digest, suggest } from './digest.js';
import {
	type Draft,
	type DraftStep,
	emptyDraft,
	readState,
	sameTarget,
	stepId,
	writeState,
} from './draft.js';
import { exportDraft, toJourney } from './export.js';
import { type Located, locate } from './locate.js';
import { createObserver } from './observe.js';
import {
	createPanel,
	type ExpectForm,
	type ExpectKind,
	needsTarget,
	type PanelView,
	type StepResult,
} from './panel.js';
import { pickElement } from './pick.js';
import { collapse, currentRoute, describeTarget, useRuntime } from './runtime.js';
import { readVars, varNames, varParams, writeVars } from './vars.js';

export { digest, suggest } from './digest.js';
export type { Draft, DraftStep, Suggestion } from './draft.js';
export { buildExport, exportDraft, toJourney } from './export.js';
export { type Health, locate } from './locate.js';

export interface EditorApi {
	draft(): Draft;
	recording(): boolean;
	record(): void;
	stop(): void;
	reset(): void;
	pick(): Promise<Target | null>;
}

type Outcome = 'pass' | 'fail' | 'stopped';

function buildExpectation(form: ExpectForm, target: Target | null): Expectation | null {
	const { kind, value } = form;
	if (kind === 'url') return value === '' ? null : { url: value };
	if (target === null) return null;
	switch (kind) {
		case 'visible':
			return { visible: target };
		case 'hidden':
			return { hidden: target };
		case 'enabled':
			return { enabled: target };
		case 'disabled':
			return { disabled: target };
		case 'text':
			return { text: [target, value] };
		case 'value':
			return { value: [target, value] };
		case 'checked':
			return { checked: [target, form.checked] };
		case 'count': {
			const n = Number.parseInt(value, 10);
			return Number.isNaN(n) ? null : { count: [target, { equals: n }] };
		}
	}
}

function labelFor(kind: ExpectKind, target: Target | null, form: ExpectForm): string {
	if (kind === 'url') return `URL is ${form.value}`;
	const name = describeTarget(target ?? undefined);
	switch (kind) {
		case 'text':
			return `${name} shows ${JSON.stringify(form.value)}`;
		case 'value':
			return `${name} value is ${JSON.stringify(form.value)}`;
		case 'checked':
			return `${name} is ${form.checked ? 'checked' : 'unchecked'}`;
		case 'count':
			return `${name} count is ${form.value}`;
		default:
			return `${name} is ${kind}`;
	}
}

declare global {
	interface Window {
		__journeyEditor?: EditorApi;
	}
}

interface Prepared {
	located: Located;
	before: Digest;
}

const SETTLE_MS = 300;
let mounted: EditorApi | null = null;

export function mountEditor(api: JourneyApi | undefined = window.__journey): EditorApi {
	if (mounted) return mounted;
	if (!api) throw new Error('journey: mount the runtime before the editor');
	useRuntime(api.resolve);

	const restored = readState();
	let draft: Draft = restored?.draft ?? emptyDraft();
	let recording = false;
	let running = false;
	let results: Record<number, StepResult> = restored?.results ?? {};
	let errors: Record<number, string> = {};
	let outcome: Outcome | null = null;
	let error: string | null = null;
	let vars = readVars();
	let expectForm: ExpectForm | null = null;

	let pendingDigest: {
		step: DraftStep;
		before: Digest;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	const finalize = (after: Digest): void => {
		if (!pendingDigest) return;
		const { step, before, timer } = pendingDigest;
		pendingDigest = null;
		clearTimeout(timer);
		if (!draft.steps.includes(step)) return;
		step.suggestions = suggest(before, after).map((s) => ({ ...s, accepted: false }));
		render();
	};

	const persist = (): void => writeState({ draft, recording, lastRoute: currentRoute(), results });

	const observer = createObserver<Prepared>({
		ignore: (event) => event.composedPath().includes(api.overlay.host),
		prepare: (el) => ({ located: locate(el), before: digest() }),
		emit(item) {
			const action: Interaction = item.do;
			const target = item.prepared?.located.target;
			if (action.kind === 'dblclick') {
				let dropped = 0;
				while (dropped < 2) {
					const last = draft.steps[draft.steps.length - 1];
					if (last?.do?.kind !== 'click' || !sameTarget(last.target, target)) break;
					draft.steps.pop();
					dropped += 1;
				}
			}
			const step: DraftStep = {
				id: stepId(target, action, item.route, draft.steps),
				do: action,
				health: item.prepared?.located.health ?? 'stable',
				suggestions: [],
			};
			if (target !== undefined) step.target = target;
			if (item.route !== undefined) step.route = item.route;
			if (draft.steps.length === 0 && step.route === undefined) step.route = currentRoute();
			draft.steps.push(step);
			results = {};
			render();
			const prepared = item.prepared;
			if (!prepared) return;
			finalize(prepared.before);
			const timer = setTimeout(() => finalize(digest()), SETTLE_MS);
			pendingDigest = { step, before: prepared.before, timer };
		},
	});

	const startRecording = (): void => {
		if (recording) return;
		recording = true;
		error = null;
		observer.start();
		render();
	};

	const stopRecording = (): void => {
		if (!recording) return;
		observer.stop();
		recording = false;
		render();
	};

	const play = (mode: 'preview' | 'run'): void => {
		stopRecording();
		const built = buildJourney();
		if (!built) return;
		running = true;
		results = {};
		errors = {};
		outcome = null;
		render();
		api.register([built]);
		const done = api.start(draft.id, { mode, params: varParams(vars) });
		attach(api.engine());
		done.catch((e: unknown) => {
			error = e instanceof Error ? e.message : String(e);
			finish('fail');
		});
	};

	const finish = (result: Outcome): void => {
		running = false;
		outcome = result;
		render();
	};

	const attach = (engine: Engine | null): void => {
		if (!engine) return;
		engine.on('step:pass', (data) => mark(data, 'pass'));
		engine.on('step:fail', (data) => {
			if (typeof data.index === 'number' && typeof data.error === 'string') {
				errors[data.index] = data.error;
			}
			mark(data, 'fail');
		});
		engine.on('step:skip', (data) => mark(data, 'skip'));
		engine.on('journey:done', (data) => finish(data.ok === false ? 'fail' : 'pass'));
		engine.on('journey:abort', () => finish('stopped'));
	};

	const status = (): string | null => {
		if (!running && outcome === null) return null;
		const total = draft.steps.length;
		const done = Object.values(results).filter((r) => r !== 'fail').length;
		return `${running ? 'running' : outcome} ${done}/${total}`;
	};

	const resumeRun = (): void => {
		const progress = readProgress();
		if (!progress || progress.id !== draft.id || progress.mode === 'driver') return;
		if (draft.steps.length === 0) return;
		const built = buildJourney();
		if (!built) return;
		running = true;
		api.register([built]);
		attach(api.engine());
		render();
	};

	const mark = (data: Record<string, unknown>, result: StepResult): void => {
		if (typeof data.index === 'number') results[data.index] = result;
		render();
	};

	const closeExpect = (): void => {
		expectForm = null;
		render();
	};

	const prefill = (form: ExpectForm, el: Element, target: Target): void => {
		form.target = target;
		if (form.kind === 'text') form.value = collapse(el.textContent);
		if (form.kind === 'value') form.value = (el as HTMLInputElement).value ?? '';
		if (form.kind === 'checked') form.checked = (el as HTMLInputElement).checked === true;
		if (form.kind === 'count') form.value = String(api.resolve.resolveAll(target).length);
	};

	const pick = async (): Promise<Target | null> => {
		if (expectForm?.picking) return null;
		if (expectForm) expectForm.picking = true;
		render();
		const el = await pickElement(api.overlay);
		if (expectForm) expectForm.picking = false;
		if (!el) {
			render();
			return null;
		}
		const located = locate(el);
		if (expectForm && needsTarget(expectForm.kind)) prefill(expectForm, located.el, located.target);
		render();
		return located.target;
	};

	const buildJourney = (): Journey | null => {
		const journey = toJourney(draft);
		const check = validate(journey);
		if (check.ok) {
			error = null;
			return journey;
		}
		error = check.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
		render();
		return null;
	};

	const panel = createPanel(api.overlay.parts.panel, {
		record: startRecording,
		stop: stopRecording,
		preview: () => play('preview'),
		run: () => play('run'),
		export() {
			stopRecording();
			void exportDraft(draft, api.options.exportUrl).then((result) => {
				error = result.ok ? null : result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
				render();
			});
		},
		field(name, value) {
			draft[name] = value;
			persist();
		},
		say(index, field, value) {
			const step = draft.steps[index];
			if (!step) return;
			step.say = { ...step.say, [field]: value };
			persist();
		},
		capture(index, on) {
			const step = draft.steps[index];
			if (!step) return;
			if (on) step.capture = step.id;
			else delete step.capture;
			persist();
		},
		suggestion(index, j, accepted) {
			const suggestion = draft.steps[index]?.suggestions[j];
			if (!suggestion) return;
			suggestion.accepted = accepted;
			persist();
		},
		remove(index) {
			draft.steps.splice(index, 1);
			results = {};
			errors = {};
			expectForm = null;
			render();
		},
		value(name, value) {
			if (value === '') delete vars[name];
			else vars[name] = value;
			writeVars(vars);
		},
		expectOpen(index) {
			stopRecording();
			expectForm = {
				index,
				kind: 'visible',
				target: null,
				value: '',
				checked: false,
				picking: false,
			};
			render();
		},
		expectSet(patch) {
			if (!expectForm) return;
			const kindChanged = patch.kind !== undefined && patch.kind !== expectForm.kind;
			Object.assign(expectForm, patch);
			if (kindChanged) {
				expectForm.target = null;
				expectForm.value = expectForm.kind === 'url' ? currentRoute() : '';
				expectForm.checked = false;
			}
			render();
		},
		expectPick() {
			void pick();
		},
		expectAdd() {
			if (!expectForm) return;
			const step = draft.steps[expectForm.index];
			const expectation = buildExpectation(expectForm, expectForm.target);
			if (!step || !expectation) return;
			step.suggestions.push({
				label: labelFor(expectForm.kind, expectForm.target, expectForm),
				expectation,
				accepted: true,
			});
			closeExpect();
		},
		expectCancel: closeExpect,
	});

	function render(): void {
		const view: PanelView = {
			draft,
			recording,
			running,
			results,
			errors,
			error,
			status: status(),
			varNames: varNames(draft),
			vars,
			expectForm,
		};
		panel.render(view);
		persist();
	}

	const editor: EditorApi = {
		draft: () => draft,
		recording: () => recording,
		record: startRecording,
		stop: stopRecording,
		reset() {
			stopRecording();
			draft = emptyDraft();
			results = {};
			errors = {};
			outcome = null;
			error = null;
			expectForm = null;
			vars = {};
			writeVars(vars);
			render();
		},
		pick,
	};
	mounted = editor;
	window.__journeyEditor = editor;
	render();
	resumeRun();
	if (restored?.recording) {
		startRecording();
		const route = currentRoute();
		if (restored.lastRoute !== route) observer.attachRoute(route);
	}
	return editor;
}

window.journeyEditor = { mountEditor };
