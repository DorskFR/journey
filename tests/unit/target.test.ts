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

test('parses a positional index segment', () => {
	expect(parseTarget('library/card[#0]')).toEqual({
		segments: [{ name: 'library' }, { name: 'card', index: 0 }],
	});
	expect(parseTarget('card[#12]')).toEqual({ segments: [{ name: 'card', index: 12 }] });
});

test('a negative index counts from the end', () => {
	expect(parseTarget('card[#-1]')).toEqual({ segments: [{ name: 'card', index: -1 }] });
});

test('an index composes with a key and with a param', () => {
	expect(parseTarget('note[a b][#0]')).toEqual({
		segments: [{ name: 'note', key: 'a b', index: 0 }],
	});
	expect(parseTarget('note[{id}][#2]')).toEqual({
		segments: [{ name: 'note', param: 'id', index: 2 }],
	});
});

test('round trips through format', () => {
	for (const path of [
		'nav',
		'nav/home',
		'notes/note[3]/delete',
		'notes/note[{id}]',
		'a.b:c-d_e',
		'library/card[#0]',
		'card[#-1]',
		'note[a b][#0]',
		'note[{id}][#2]',
		'app/card>>ok',
		'card[3]>>pay/submit[#0]',
		'card>>',
		'a>>b>>c',
	]) {
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
		'card[#]',
		'card[#a]',
		'card[#1.5]',
		'card[#0][#1]',
		'card[#0][a]',
		'card[a][b]',
		'>>ok',
		'card>>>>ok',
		'card>>/ok',
		'card>',
		'card>ok',
	]) {
		expect(() => parseTarget(bad), bad).toThrow(JSON.stringify(bad));
	}
});

test('>> marks the segment whose shadow root or frame the next one is in', () => {
	expect(parseTarget('app/card >> ok')).toEqual({
		segments: [{ name: 'app' }, { name: 'card', into: true }, { name: 'ok' }],
	});
	expect(parseTarget('frame[a]>>')).toEqual({
		segments: [{ name: 'frame', key: 'a', into: true }],
	});
});

test('>> inside a key is part of the key', () => {
	expect(parseTarget('note[a>>b]')).toEqual({ segments: [{ name: 'note', key: 'a>>b' }] });
});
