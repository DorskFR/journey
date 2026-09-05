import { compile } from '../core/compile.js';
import { print } from '../core/print.js';
import type { Expectation, IR, Journey, Step, ValidationError } from '../core/types.js';
import { validate } from '../core/validate.js';
import type { Draft, DraftStep } from './draft.js';

export interface ExportDetail {
	id: string;
	source: string;
	ir: IR;
}

export type ExportResult =
	| { ok: true; detail: ExportDetail }
	| { ok: false; errors: ValidationError[] };

function toStep(step: DraftStep): Step {
	const out: Step = { id: step.id };
	if (step.route !== undefined) out.route = step.route;
	if (step.target !== undefined) out.target = step.target;
	if (step.params !== undefined) out.params = step.params;
	out.do = step.do ?? { kind: 'none' };
	const title = step.say?.title;
	const body = step.say?.body;
	if (title || body) {
		out.say = {};
		if (title) out.say.title = title;
		if (body) out.say.body = body;
	}
	const expect: Expectation[] = step.suggestions
		.filter((s) => s.accepted)
		.map((s) => s.expectation);
	if (expect.length > 0) out.expect = expect;
	if (step.capture !== undefined) out.capture = step.capture;
	return out;
}

export function toJourney(draft: Draft): Journey {
	const journey: Journey = { id: draft.id, steps: draft.steps.map(toStep) };
	if (draft.title !== '') journey.title = draft.title;
	journey.route = draft.route;
	return journey;
}

export function buildExport(draft: Draft): ExportResult {
	const journey = toJourney(draft);
	const result = validate(journey);
	if (!result.ok) return { ok: false, errors: result.errors };
	const ir = compile(journey);
	return { ok: true, detail: { id: ir.id, source: print(ir), ir } };
}

function download(name: string, source: string): void {
	const url = URL.createObjectURL(new Blob([source], { type: 'text/typescript' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDraft(draft: Draft, exportUrl?: string): Promise<ExportResult> {
	const built = buildExport(draft);
	if (!built.ok) return built;
	const { detail } = built;
	download(`${detail.id}.journey.ts`, detail.source);
	try {
		await navigator.clipboard?.writeText(detail.source);
	} catch {}
	window.dispatchEvent(new CustomEvent('journey:export', { detail }));
	if (exportUrl) {
		try {
			await fetch(exportUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(detail),
			});
		} catch {}
	}
	return built;
}
