import { expect, test } from '@playwright/test';
import { compile } from '../../src/core/compile.js';
import type { Journey } from '../../src/core/types.js';
import { planParams } from '../../src/runtime/text.js';

const NOTE: Journey = {
	id: 'note',
	route: '/',
	steps: [
		{ id: 'title', target: 'title', do: { kind: 'fill', value: { $param: 'var.title' } } },
		{ id: 'check', target: 'title', expect: [{ value: ['title', { $param: 'var.title' }] }] },
		{ id: 'open', target: 'notes/note[{key}]', params: { key: { $param: 'fixture.id' } } },
	],
};

test('a guide asks for a fill param nobody supplied, and later steps use it', () => {
	const plan = planParams(compile(NOTE), { 'fixture.id': '3' }, { human: true });
	expect(plan).toEqual({ ask: ['var.title'], missing: null });
});

test('a scripted run reports the first fill param nobody supplied', () => {
	const plan = planParams(compile(NOTE), { 'fixture.id': '3' });
	expect(plan.missing).toEqual({ stepId: 'title', param: 'var.title' });
});

test('a step param is never asked, even in a guide', () => {
	const plan = planParams(compile(NOTE), {}, { human: true });
	expect(plan.missing).toEqual({ stepId: 'open', param: 'fixture.id' });
});

test('a param read before the step that asks for it is missing', () => {
	const ir = compile({
		...NOTE,
		steps: [NOTE.steps[1], NOTE.steps[0]] as Journey['steps'],
	});
	expect(planParams(ir, {}, { human: true }).missing).toEqual({
		stepId: 'check',
		param: 'var.title',
	});
});

test('target path params come from the run or the step', () => {
	const ir = compile({ id: 'p', route: '/', steps: [{ id: 'a', target: 'notes/note[{key}]' }] });
	expect(planParams(ir, {}).missing).toEqual({ stepId: 'a', param: 'key' });
	expect(planParams(ir, { key: '1' }).missing).toBeNull();
});

test('skipped steps and steps before `from` are not checked', () => {
	const ir = compile({
		id: 'w',
		route: '/',
		steps: [
			{ id: 'early', target: 'a', do: { kind: 'fill', value: { $param: 'x' } } },
			{ id: 'phone', when: { viewport: 'mobile' }, target: 'a[{y}]' },
		],
	});
	expect(planParams(ir, {}, { from: 1, variant: { viewport: 'desktop' } }).missing).toBeNull();
	expect(planParams(ir, {}, { from: 1, variant: { viewport: 'mobile' } }).missing).toEqual({
		stepId: 'phone',
		param: 'y',
	});
});
