import type { CompileOptions, Expectation, IR, IRStep, Journey, Step } from './types.js';
import { assertValid } from './validate.js';

function isQaProbe(e: Expectation): boolean {
	return 'probe' in e && e.probe.startsWith('qa.');
}

function compileStep(step: Step, isPublic: boolean): IRStep {
	const action = step.do ?? { kind: 'none' };
	const out: IRStep = {
		id: step.id,
		do: action,
		guide: step.guide ?? (action.kind === 'none' ? 'next' : 'wait-for-user'),
		timeout: step.timeout ?? 10000,
	};
	if (step.route !== undefined) out.route = step.route;
	if (step.target !== undefined) out.target = step.target;
	if (step.params !== undefined) out.params = step.params;
	if (step.say !== undefined) out.say = step.say;
	if (step.expect !== undefined) {
		out.expect = isPublic ? step.expect.filter((e) => !isQaProbe(e)) : step.expect;
	}
	if (step.capture !== undefined) {
		out.capture = typeof step.capture === 'string' ? { name: step.capture } : step.capture;
	}
	if (step.when !== undefined) out.when = step.when;
	if (step.optional !== undefined) out.optional = step.optional;
	if (step.qaOnly !== undefined) out.qaOnly = step.qaOnly;
	return out;
}

export function compile(journey: Journey, options: CompileOptions = {}): IR {
	assertValid(journey);
	const isPublic = options.public === true;
	const steps = isPublic ? journey.steps.filter((s) => !s.qaOnly) : journey.steps;
	const ir: IR = {
		id: journey.id,
		version: journey.version ?? 1,
		route: journey.route ?? '/',
		level: journey.level ?? 'smoke',
		steps: steps.map((s) => compileStep(s, isPublic)),
	};
	if (journey.title !== undefined) ir.title = journey.title;
	if (journey.description !== undefined) ir.description = journey.description;
	if (journey.variants !== undefined) ir.variants = journey.variants;
	if (journey.fixture !== undefined) ir.fixture = journey.fixture;
	if (journey.mask !== undefined) ir.mask = journey.mask;
	if (journey.autostart !== undefined) ir.autostart = journey.autostart;
	return JSON.parse(JSON.stringify(ir)) as IR;
}
