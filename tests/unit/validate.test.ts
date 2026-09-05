import { expect, test } from '@playwright/test';
import { defineJourney, msg, param, validate } from '../../src/index.js';

const valid = defineJourney({
	id: 'create-note',
	title: 'Create a note',
	variants: { viewport: ['desktop', 'mobile'] },
	steps: [
		{
			id: 'start',
			route: '/',
			target: 'start',
			do: { kind: 'click' },
			expect: [{ url: '/#notes' }],
		},
		{
			id: 'fill',
			target: 'dialog/title',
			do: { kind: 'fill', value: param('var.title') },
			say: { title: msg('fill.title'), body: { en: 'Type a title', fr: 'Saisir un titre' } },
			expect: [
				{ enabled: 'dialog/save' },
				{ count: ['notes/note', { equals: 4 }] },
				{ text: [{ role: 'status' }, 'Saved'] },
				{ probe: 'theme', equals: 'dark' },
			],
			capture: { name: 'saved', video: true },
		},
	],
});

function paths(journey: unknown): string[] {
	return validate(journey).errors.map((e) => e.path);
}

test('a valid journey passes', () => {
	expect(validate(valid)).toEqual({ ok: true, errors: [] });
});

test('rejects duplicate step ids with the second index', () => {
	const j = { id: 'j', steps: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] };
	const result = validate(j);
	expect(result.ok).toBe(false);
	expect(result.errors).toEqual([
		{ path: 'steps[2].id', message: expect.stringContaining('duplicate step id "a"') },
	]);
});

test('rejects function values', () => {
	const j = { id: 'j', steps: [{ id: 'a', say: { title: () => 'hi' } }] };
	expect(paths(j)).toEqual(['steps[0].say.title']);
});

test('rejects unknown keys at every level', () => {
	const j = {
		id: 'j',
		extra: 1,
		steps: [{ id: 'a', target: { role: 'button', foo: 1 }, do: { kind: 'click', value: 'x' } }],
	};
	expect(paths(j)).toEqual(['extra', 'steps[0].target.foo', 'steps[0].do.value']);
});

test('rejects bad target syntax', () => {
	const j = { id: 'j', steps: [{ id: 'a', target: 'notes//new', do: { kind: 'click' } }] };
	const result = validate(j);
	expect(result.errors).toHaveLength(1);
	expect(result.errors[0]?.path).toBe('steps[0].target');
	expect(result.errors[0]?.message).toContain('notes//new');
});

test('rejects unknown expectation shapes', () => {
	const j = {
		id: 'j',
		steps: [
			{ id: 'a' },
			{ id: 'b' },
			{
				id: 'c',
				expect: [{ shown: 'x' }, { visible: 'ok' }, { text: ['x'] }, { visible: 'a', hidden: 'b' }],
			},
		],
	};
	expect(paths(j)).toEqual(['steps[2].expect[0]', 'steps[2].expect[2].text', 'steps[2].expect[3]']);
});

test('rejects missing steps', () => {
	expect(validate({ id: 'j' })).toEqual({
		ok: false,
		errors: [{ path: 'steps', message: 'steps is required' }],
	});
});

test('rejects a missing id and target for an interaction', () => {
	const j = { id: 'j', steps: [{ do: { kind: 'click' } }] };
	expect(paths(j)).toEqual(['steps[0].id', 'steps[0].target']);
});

test('rejects non-objects', () => {
	expect(validate(null).ok).toBe(false);
	expect(validate([]).ok).toBe(false);
});
