import type { Interaction, Target } from '../core/types.js';
import type { Draft, DraftStep, StepResult } from './draft.js';

export type { StepResult };

export interface PanelView {
	draft: Draft;
	recording: boolean;
	running: boolean;
	results: Record<number, StepResult>;
	error: string | null;
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
.jp input[type=text]{width:100%;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font:inherit;color:#111;background:#fff}
.jp .fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.jp .fields label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#555}
.jp .toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.jp .error{margin:0 0 8px;padding:6px 8px;border-radius:4px;background:#fde7e7;color:#8a1c1c;white-space:pre-wrap}
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

function describeTarget(target: Target | undefined): string {
	if (target === undefined) return '(no target)';
	if (typeof target === 'string') return target;
	const parts = Object.entries(target).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
	return `{ ${parts.join(', ')} }`;
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
	li.append(el('div', { class: 'opts' }, el('label', {}, capture, ' Capture')));
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
	toggle.addEventListener('click', () => {
		open = !open;
		body.hidden = !open;
		toggle.textContent = open ? 'Hide' : 'Show';
		toggle.setAttribute('aria-expanded', String(open));
	});
	const wrapper = el('div', { class: 'jp', role: 'region', 'aria-label': 'Journey editor' });
	wrapper.append(el('header', {}, el('strong', {}, 'Journey editor'), toggle), body);
	container.append(style, wrapper);

	const button = (
		label: string,
		name: string,
		cls: string,
		onClick: () => void,
		disabled: boolean,
	): HTMLButtonElement => {
		const b = el('button', { type: 'button', 'data-editor': name, class: cls }, label);
		b.disabled = disabled;
		b.addEventListener('click', onClick);
		return b;
	};

	return {
		render(view) {
			body.replaceChildren();
			const { draft } = view;
			const fields = el('div', { class: 'fields' });
			fields.append(
				el(
					'label',
					{},
					'Id',
					textInput({ 'data-editor': 'id' }, draft.id, (v) => actions.field('id', v)),
				),
				el(
					'label',
					{},
					'Title',
					textInput({ 'data-editor': 'title' }, draft.title, (v) => actions.field('title', v)),
				),
			);
			const busy = view.running;
			const toolbar = el('div', { class: 'toolbar' });
			toolbar.append(
				view.recording
					? button('Stop', 'stop', 'rec', actions.stop, false)
					: button('Record', 'record', 'primary', actions.record, busy),
				button(
					'Preview',
					'preview',
					'',
					actions.preview,
					busy || view.recording || draft.steps.length === 0,
				),
				button('Run', 'run', '', actions.run, busy || view.recording || draft.steps.length === 0),
				button('Export', 'export', '', actions.export, view.recording || draft.steps.length === 0),
			);
			body.append(fields, toolbar);
			const error = el(
				'p',
				{ class: 'error', 'data-editor': 'error', role: 'alert' },
				view.error ?? '',
			);
			error.hidden = view.error === null;
			body.append(error);
			if (draft.steps.length === 0) {
				body.append(
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
			body.append(list);
		},
	};
}
