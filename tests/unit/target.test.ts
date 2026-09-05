import { expect, test } from '@playwright/test';
import { formatTarget, parseTarget } from '../../src/core/target.js';

test('parses a single segment', () => {
	expect(parseTarget('notes')).toEqual({ segments: [{ name: 'notes' }] });
});

test('parses nested segments with keys', () => {
	expect(parseTarget('notes/note[3]/pin')).toEqual({
		segments: [{ name: 'notes' }, { name: 'note', key: '3' }, { name: 'pin' }],
	});
});

test('parses param keys', () => {
	expect(parseTarget('notes/note[{id}]')).toEqual({
		segments: [{ name: 'notes' }, { name: 'note', param: 'id' }],
	});
});

test('ignores whitespace around separators', () => {
	expect(parseTarget(' notes / note[a b] ')).toEqual({
		segments: [{ name: 'notes' }, { name: 'note', key: 'a b' }],
	});
});

test('round trips through format', () => {
	for (const path of ['nav', 'nav/home', 'notes/note[3]/delete', 'notes/note[{id}]', 'a.b:c-d_e']) {
		expect(formatTarget(parseTarget(path))).toBe(path);
	}
});

test('throws with the offending path', () => {
	for (const bad of [
		'',
		'notes//new',
		'notes/',
		'no tes',
		'note[',
		'note[]',
		'note[x]y',
		'/notes',
	]) {
		expect(() => parseTarget(bad), bad).toThrow(JSON.stringify(bad));
	}
});
