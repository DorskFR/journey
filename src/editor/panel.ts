import type { Interaction, Target } from '../core/types.js';
import type { Draft, DraftStep, StepResult } from './draft.js';
import { describeTarget } from './runtime.js';

export type { StepResult };

export const EXPECT_KINDS = [
	'visible',
	'hidden',
	'text',
	'value',
	'checked',
	'enabled',
	'disabled',
	'url',
	'count',
] as const;

export type ExpectKind = (typeof EXPECT_KINDS)[number];

export interface ExpectForm {
	index: number;
	kind: ExpectKind;
	target: Target | null;
	value: string;
	checked: boolean;
	picking: boolean;
}

export interface PanelView {
	draft: Draft;
	recording: boolean;
	running: boolean;
	results: Record<number, StepResult>;
	errors: Record<number, string>;
	error: string | null;
	status: string | null;
	varNames: string[];
	vars: Record<string, string>;
	expectForm: ExpectForm | null;
}

export interface PanelActions {
	record(): void;
	stop(): void;
	preview(): void;
	run(): void;
	export(): void;
	field(name: 'id' | 'title', value: string): void;
	say(index: number, field: 'title' | 'body', value: string): void;
	capture(index: number, on: boolean): void;
	suggestion(index: number, suggestion: number, accepted: boolean): void;
	remove(index: number): void;
	value(name: string, value: string): void;
	expectOpen(index: number): void;
	expectSet(patch: Partial<ExpectForm>): void;
	expectPick(): void;
	expectAdd(): void;
	expectCancel(): void;
}

export function needsTarget(kind: ExpectKind): boolean {
	return kind !== 'url';
}

export function needsValue(kind: ExpectKind): boolean {
	return kind === 'text' || kind === 'value' || kind === 'count' || kind === 'url';
}

export interface Panel {
	render(view: PanelView): void;
}

const CSS_TEXT = `
.jp{width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);margin:8px;display:flex;flex-direction:column;border-radius:8px;background:#fff;color:#111;box-shadow:0 8px 24px rgba(0,0,0,.25);font:13px/1.4 system-ui,sans-serif}
.jp header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e5e5}
.jp header strong{font-size:14px}
.jp .body{overflow:auto;padding:8px 12px}
.jp button{padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:inherit;cursor:pointer}
.jp button:disabled{opacity:.5;cursor:default}
.jp button.primary{background:#ffd166;border-color:#ffd166;font-weight:600}
.jp button.rec{background:#d32f2f;border-color:#d32f2f;color:#fff;font-weight:600}
.jp input[type=text],.jp input[type=password],.jp input[type=number],.jp select{width:100%;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font:inherit;color:#111;background:#fff}
.jp .fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.jp .fields label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#555}
.jp .toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.jp .error{margin:0 0 8px;padding:6px 8px;border-radius:4px;background:#fde7e7;color:#8a1c1c;white-space:pre-wrap}
.jp li.step .error{margin:4px 0 4px 24px;font-family:ui-monospace,monospace;font-size:12px}
.jp .vars{margin-bottom:8px}
.jp .vars h3{margin:0 0 4px;font-size:12px;color:#555}
.jp .vars label{display:grid;grid-template-columns:1fr 2fr;align-items:center;gap:6px;margin-bottom:4px;font-size:12px}
.jp .expect-form{display:grid;gap:4px;margin:4px 0 4px 24px;padding:6px;border:1px solid #e5e5e5;border-radius:4px}
.jp .expect-form .line{display:flex;align-items:center;gap:6px}
.jp .expect-form .target{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}
.jp ol{list-style:none;margin:0;padding:0}
.jp li.step{padding:8px 0;border-top:1px solid #eee}
.jp li.step[data-result=pass]{background:#eef8ee}
.jp li.step[data-result=fail]{background:#fde7e7}
.jp li.step[data-result=skip]{background:#f4f4f4}
.jp .row{display:flex;align-items:center;gap:6px}
.jp .row .index{min-width:18px;color:#555}
.jp .row .target{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}
.jp .row .result{font-weight:700}
.jp .action{margin:2px 0 4px 24px;color:#333}
.jp .health{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none}
.jp .health[data-health=stable]{background:#2e7d32}
.jp .health[data-health=fallback]{background:#f0a500}
.jp .health[data-health=fragile]{background:#d32f2f}
.jp .say{display:grid;gap:4px;margin:0 0 4px 24px}
.jp .opts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px 24px}
.jp ul.expect{list-style:none;margin:0 0 0 24px;padding:0}
.jp ul.expect li{display:flex;align-items:center;gap:6px}
.jp ul.expect button{padding:0 6px;font-size:11px}
.jp .empty{margin:8px 0;color:#555}
`;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<Record<string, string>> = {},
	...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(props)) {
		if (value !== undefined) node.setAttribute(name, value);
	}
	node.append(...children);
	return node;
}

function textInput(
	props: Record<string, string>,
	value: string,
	onInput: (v: string) => void,
): HTMLInputElement {
	const input = el('input', { type: 'text', ...props });
	input.value = value;
	input.addEventListener('input', () => onInput(input.value));
	return input;
}

function describeAction(step: DraftStep): string {
	const action: Interaction = step.do ?? { kind: 'none' };
	switch (action.kind) {
		case 'fill':
			return typeof action.value === 'string'
				? `fill ${JSON.stringify(action.value)}`
				: `fill {${action.value.$param}}${action.mask ? ' (masked)' : ''}`;
		case 'select':
			return `select ${typeof action.value === 'string' ? JSON.stringify(action.value) : `{${action.value.$param}}`}`;
		case 'check':
			return action.checked ? 'check' : 'uncheck';
		case 'press':
			return `press ${action.key}`;
		case 'navigate':
			return `navigate ${action.url}`;
		case 'none':
			return step.route === undefined ? 'wait' : `go to ${step.route}`;
		default:
			return action.kind;
	}
}

const RESULT_MARK: Record<StepResult, string> = { pass: 'pass', fail: 'fail', skip: 'skip' };

function expectForm(form: ExpectForm, actions: PanelActions): HTMLElement {
	const root = el('div', { class: 'expect-form', 'data-editor': 'expect-form' });
	const kind = el('select', { 'data-editor': 'expect-kind', 'aria-label': 'Expectation kind' });
	for (const name of EXPECT_KINDS) kind.append(el('option', { value: name }, name));
	kind.value = form.kind;
	kind.addEventListener('change', () => actions.expectSet({ kind: kind.value as ExpectKind }));
	root.append(el('div', { class: 'line' }, kind));
	if (needsTarget(form.kind)) {
		const pick = el('button', { type: 'button', 'data-editor': 'pick' }, 'Pick element');
		pick.disabled = form.picking;
		pick.addEventListener('click', actions.expectPick);
		root.append(
			el(
				'div',
				{ class: 'line' },
				pick,
				el(
					'span',
					{ class: 'target', 'data-editor': 'expect-target' },
					form.picking ? 'Click an element on the page' : describeTarget(form.target ?? undefined),
				),
			),
		);
	}
	if (needsValue(form.kind)) {
		const input = el('input', {
			type: form.kind === 'count' ? 'number' : 'text',
			'data-editor': 'expect-value',
			'aria-label': `Expected ${form.kind}`,
		});
		input.value = form.value;
		input.addEventListener('input', () => actions.expectSet({ value: input.value }));
		root.append(el('div', { class: 'line' }, input));
	}
	if (form.kind === 'checked') {
		const box = el('input', { type: 'checkbox', 'data-editor': 'expect-checked' });
		box.checked = form.checked;
		box.addEventListener('change', () => actions.expectSet({ checked: box.checked }));
		root.append(el('label', { class: 'line' }, box, ' Checked'));
	}
	const add = el(
		'button',
		{ type: 'button', 'data-editor': 'expect-add', class: 'primary' },
		'Add',
	);
	add.disabled = needsTarget(form.kind) && form.target === null;
	add.addEventListener('click', actions.expectAdd);
	const cancel = el('button', { type: 'button', 'data-editor': 'expect-cancel' }, 'Cancel');
	cancel.addEventListener('click', actions.expectCancel);
	root.append(el('div', { class: 'line' }, add, cancel));
	return root;
}

function stepRow(
	step: DraftStep,
	index: number,
	view: PanelView,
	actions: PanelActions,
): HTMLLIElement {
	const li = el('li', { class: 'step', 'data-editor': 'step', 'data-index': String(index) });
	const result = view.results[index];
	if (result) li.dataset.result = result;
	const health = el('span', {
		class: 'health',
		'data-editor': 'health',
		'data-health': step.health,
		role: 'img',
		'aria-label': `target health: ${step.health}`,
		title: `Target health: ${step.health}`,
	});
	const target = el(
		'span',
		{ class: 'target', title: describeTarget(step.target) },
		describeTarget(step.target),
	);
	const mark = el(
		'span',
		{ class: 'result', 'data-editor': 'result' },
		result ? RESULT_MARK[result] : '',
	);
	const remove = el(
		'button',
		{ type: 'button', 'data-editor': 'delete', 'aria-label': `Delete step ${index + 1}` },
		'x',
	);
	remove.addEventListener('click', () => actions.remove(index));
	li.append(
		el(
			'div',
			{ class: 'row' },
			el('span', { class: 'index' }, String(index + 1)),
			health,
			target,
			mark,
			remove,
		),
		el(
			'div',
			{ class: 'action' },
			describeAction(step) +
				(step.route !== undefined && step.do?.kind !== 'none' ? ` (at ${step.route})` : ''),
		),
	);
	const say = el('div', { class: 'say' });
	say.append(
		textInput(
			{
				'data-editor': 'say-title',
				placeholder: 'Say: title',
				'aria-label': `Step ${index + 1} title`,
			},
			step.say?.title === undefined ? '' : String(step.say.title),
			(v) => actions.say(index, 'title', v),
		),
		textInput(
			{
				'data-editor': 'say-body',
				placeholder: 'Say: body',
				'aria-label': `Step ${index + 1} body`,
			},
			step.say?.body === undefined ? '' : String(step.say.body),
			(v) => actions.say(index, 'body', v),
		),
	);
	li.append(say);
	const capture = el('input', { type: 'checkbox', 'data-editor': 'capture' });
	capture.checked = step.capture !== undefined;
	capture.addEventListener('change', () => actions.capture(index, capture.checked));
	const failure = view.errors[index];
	if (failure !== undefined) {
		li.append(el('p', { class: 'error', 'data-editor': 'error' }, failure));
	}
	const addExpect = el(
		'button',
		{
			type: 'button',
			'data-editor': 'add-expect',
			'aria-label': `Add expectation to step ${index + 1}`,
		},
		'Add expectation',
	);
	addExpect.disabled = view.expectForm !== null;
	addExpect.addEventListener('click', () => actions.expectOpen(index));
	li.append(el('div', { class: 'opts' }, el('label', {}, capture, ' Capture'), addExpect));
	if (view.expectForm?.index === index) li.append(expectForm(view.expectForm, actions));
	if (step.suggestions.length > 0) {
		const list = el('ul', { class: 'expect', 'aria-label': `Step ${index + 1} expectations` });
		step.suggestions.forEach((s, j) => {
			const item = el('li', {});
			const box = el('input', {
				type: 'checkbox',
				'data-editor': 'suggestion',
				'data-suggestion': String(j),
			});
			box.checked = s.accepted;
			const drop = el(
				'button',
				{
					type: 'button',
					'data-editor': 'remove-expect',
					'aria-label': `Remove expectation: ${s.label}`,
				},
				'remove',
			);
			drop.hidden = !s.accepted;
			box.addEventListener('change', () => {
				drop.hidden = !box.checked;
				actions.suggestion(index, j, box.checked);
			});
			drop.addEventListener('click', () => {
				box.checked = false;
				drop.hidden = true;
				actions.suggestion(index, j, false);
			});
			item.append(el('label', {}, box, ` ${s.label}`), drop);
			list.append(item);
		});
		li.append(list);
	}
	return li;
}

export function createPanel(container: HTMLElement, actions: PanelActions): Panel {
	let open = true;
	container.replaceChildren();
	const style = el('style', {}, CSS_TEXT);
	const body = el('div', { class: 'body' });
	const toggle = el(
		'button',
		{ type: 'button', 'data-editor': 'toggle', 'aria-expanded': 'true' },
		'Hide',
	);
	let status: string | null = null;
	const setOpen = (next: boolean): void => {
		open = next;
		body.hidden = !open;
		toggle.textContent = open ? 'Hide' : (status ?? 'Show');
		toggle.setAttribute('aria-expanded', String(open));
	};
	toggle.addEventListener('click', () => setOpen(!open));
	const wrapper = el('div', { class: 'jp', role: 'region', 'aria-label': 'Journey editor' });
	wrapper.append(el('header', {}, el('strong', {}, 'Journey editor'), toggle), body);
	container.append(style, wrapper);

	const button = (
		label: string,
		name: string,
		cls: string,
		onClick: () => void,
	): HTMLButtonElement => {
		const b = el('button', { type: 'button', 'data-editor': name, class: cls }, label);
		b.addEventListener('click', onClick);
		return b;
	};

	const collapseThen = (action: () => void) => (): void => {
		setOpen(false);
		action();
	};

	const idInput = textInput({ 'data-editor': 'id' }, '', (v) => actions.field('id', v));
	const titleInput = textInput({ 'data-editor': 'title' }, '', (v) => actions.field('title', v));
	const fields = el('div', { class: 'fields' });
	fields.append(el('label', {}, 'Id', idInput), el('label', {}, 'Title', titleInput));
	const record = button('Record', 'record', 'primary', actions.record);
	const stop = button('Stop', 'stop', 'rec', actions.stop);
	const preview = button('Preview', 'preview', '', collapseThen(actions.preview));
	const run = button('Run', 'run', '', collapseThen(actions.run));
	const exportButton = button('Export', 'export', '', actions.export);
	const toolbar = el('div', { class: 'toolbar' }, record, stop, preview, run, exportButton);
	const content = el('div', {});
	body.append(fields, toolbar, content);

	return {
		render(view) {
			status = view.status;
			setOpen(open);
			const { draft } = view;
			if (idInput.value !== draft.id) idInput.value = draft.id;
			if (titleInput.value !== draft.title) titleInput.value = draft.title;
			const busy = view.running;
			const empty = draft.steps.length === 0;
			record.hidden = view.recording;
			record.disabled = busy;
			stop.hidden = !view.recording;
			preview.disabled = busy || view.recording || empty;
			run.disabled = busy || view.recording || empty;
			exportButton.disabled = view.recording || empty;
			content.replaceChildren();
			const error = el(
				'p',
				{ class: 'error', 'data-editor': 'error', role: 'alert' },
				view.error ?? '',
			);
			error.hidden = view.error === null;
			content.append(error);
			if (view.varNames.length > 0) {
				const vars = el('section', { class: 'vars', 'aria-label': 'Values' });
				vars.append(el('h3', {}, 'Values'));
				for (const name of view.varNames) {
					const input = el('input', {
						type: 'password',
						'data-editor': 'var',
						'data-name': name,
						autocomplete: 'off',
					});
					input.value = view.vars[name] ?? '';
					input.addEventListener('input', () => actions.value(name, input.value));
					vars.append(el('label', {}, name, input));
				}
				content.append(vars);
			}
			if (empty) {
				content.append(
					el(
						'p',
						{ class: 'empty' },
						view.recording
							? 'Recording. Use the page to add steps.'
							: 'No steps yet. Press Record and use the page.',
					),
				);
				return;
			}
			const list = el('ol', { 'aria-label': 'Steps' });
			list.append(...draft.steps.map((step, i) => stepRow(step, i, view, actions)));
			content.append(list);
		},
	};
}
