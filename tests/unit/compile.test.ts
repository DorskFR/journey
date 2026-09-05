import { expect, test } from '@playwright/test';
import { compile, defineJourney } from '../../src/index.js';

const journey = defineJourney({
	id: 'settings',
	steps: [
		{ id: 'open', route: '/settings.html' },
		{ id: 'theme', target: 'theme', do: { kind: 'select', value: 'dark' }, capture: 'dark' },
		{
			id: 'check',
			expect: [
				{ probe: 'theme', equals: 'dark' },
				{ probe: 'qa.internal', equals: 1 },
			],
		},
		{ id: 'escape', do: { kind: 'press', key: 'Escape' }, target: 'theme', qaOnly: true },
	],
});

test('fills defaults', () => {
	const ir = compile(journey);
	expect(ir.version).toBe(1);
	expect(ir.route).toBe('/');
	expect(ir.level).toBe('smoke');
	expect(ir.steps[0]).toEqual({
		id: 'open',
		route: '/settings.html',
		do: { kind: 'none' },
		guide: 'next',
		timeout: 10000,
	});
	expect(ir.steps[1]).toEqual({
		id: 'theme',
		target: 'theme',
		do: { kind: 'select', value: 'dark' },
		guide: 'wait-for-user',
		timeout: 10000,
		capture: { name: 'dark' },
	});
});

test('keeps explicit values', () => {
	const ir = compile({
		...journey,
		version: 3,
		route: '/x',
		level: 'visual',
		steps: [{ id: 'a', guide: 'next', timeout: 50, target: 'x', do: { kind: 'click' } }],
	});
	expect(ir.version).toBe(3);
	expect(ir.route).toBe('/x');
	expect(ir.level).toBe('visual');
	expect(ir.steps[0]?.guide).toBe('next');
	expect(ir.steps[0]?.timeout).toBe(50);
});

test('public strips qaOnly steps and qa. probes', () => {
	const ir = compile(journey, { public: true });
	expect(ir.steps.map((s) => s.id)).toEqual(['open', 'theme', 'check']);
	expect(ir.steps[2]?.expect).toEqual([{ probe: 'theme', equals: 'dark' }]);
	expect(compile(journey).steps).toHaveLength(4);
	expect(compile(journey).steps[2]?.expect).toHaveLength(2);
});

test('IR is plain JSON', () => {
	const ir = compile(journey);
	expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
	expect(Object.getPrototypeOf(ir)).toBe(Object.prototype);
});

test('throws on an invalid journey', () => {
	expect(() => compile({ id: 'x', steps: [{ id: 'a' }, { id: 'a' }] })).toThrow('steps[1].id');
});
