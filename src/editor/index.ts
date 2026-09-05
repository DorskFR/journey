import type { Interaction, Journey } from '../core/types.js';
import { validate } from '../core/validate.js';
import type { JourneyApi } from '../runtime/index.js';
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
import { createPanel, type PanelView, type StepResult } from './panel.js';
import { currentRoute, useRuntime } from './runtime.js';

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
	let results: Record<number, StepResult> = {};
	let error: string | null = null;

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

	const persist = (): void => writeState({ draft, recording, lastRoute: currentRoute() });

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
		render();
		api.register([built]);
		const done = api.start(draft.id, { mode });
		const engine = api.engine();
		engine?.on('step:pass', (data) => mark(data, 'pass'));
		engine?.on('step:fail', (data) => mark(data, 'fail'));
		engine?.on('step:skip', (data) => mark(data, 'skip'));
		done
			.catch((e: unknown) => {
				error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				running = false;
				render();
			});
	};

	const mark = (data: Record<string, unknown>, result: StepResult): void => {
		if (typeof data.index === 'number') results[data.index] = result;
		render();
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
			render();
		},
	});

	function render(): void {
		const view: PanelView = { draft, recording, running, results, error };
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
			error = null;
			render();
		},
	};
	mounted = editor;
	window.__journeyEditor = editor;
	render();
	if (restored?.recording) {
		startRecording();
		const route = currentRoute();
		if (restored.lastRoute !== route) observer.attachRoute(route);
	}
	return editor;
}

window.journeyEditor = { mountEditor };
