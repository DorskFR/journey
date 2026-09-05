import type { IR } from './types.js';

const KEY_ORDER: Record<string, string[]> = {
	journey: [
		'id',
		'version',
		'title',
		'description',
		'route',
		'variants',
		'fixture',
		'mask',
		'level',
		'autostart',
		'steps',
	],
	step: [
		'id',
		'route',
		'target',
		'params',
		'do',
		'guide',
		'say',
		'expect',
		'capture',
		'when',
		'optional',
		'timeout',
		'qaOnly',
	],
	locator: ['role', 'name', 'label', 'text', 'testid', 'css', 'within', 'nth'],
	do: ['kind', 'value', 'mask', 'checked', 'key', 'url'],
	say: ['title', 'body'],
	capture: ['name', 'video', 'crop'],
	autostart: ['route', 'once'],
	count: ['min', 'max', 'equals'],
	probe: ['probe', 'equals'],
};

const INLINE_WIDTH = 80;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

class Printer {
	usesMsg = false;
	usesParam = false;

	value(v: Json, kind: string, depth: number): string {
		if (v === null) return 'null';
		if (typeof v === 'string') return quote(v);
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		if (Array.isArray(v)) return this.array(v, kind, depth);
		return this.object(v, kind, depth);
	}

	array(items: Json[], kind: string, depth: number): string {
		if (items.length === 0) return '[]';
		const childKind = kind === 'steps' ? 'step' : kind === 'expect' ? 'expectation' : kind;
		const rendered = items.map((item, i) => this.value(item, tupleKind(childKind, i), depth + 1));
		if (childKind !== 'step' && kind !== 'expect') {
			const inline = `[${rendered.join(', ')}]`;
			if (!inline.includes('\n') && inline.length + depth * 4 <= INLINE_WIDTH) return inline;
		}
		const pad = '\t'.repeat(depth + 1);
		return `[\n${rendered.map((s) => `${pad}${s},`).join('\n')}\n${'\t'.repeat(depth)}]`;
	}

	object(obj: { [k: string]: Json }, kind: string, depth: number): string {
		const keys = Object.keys(obj);
		if (keys.length === 1 && keys[0] === '$msg' && typeof obj.$msg === 'string') {
			this.usesMsg = true;
			return `msg(${quote(obj.$msg)})`;
		}
		if (keys.length === 1 && keys[0] === '$param' && typeof obj.$param === 'string') {
			this.usesParam = true;
			return `param(${quote(obj.$param)})`;
		}
		const ordered = orderKeys(keys, kind === 'expectation' ? expectationKind(keys) : kind);
		if (ordered.length === 0) return '{}';
		const entries = ordered.map((k) => {
			const child = obj[k] as Json;
			return `${IDENT.test(k) ? k : quote(k)}: ${this.value(child, childKind(kind, k), depth + 1)}`;
		});
		const allPrimitive = ordered.every((k) => {
			const child = obj[k];
			return typeof child !== 'object' || child === null || isRef(child);
		});
		if (allPrimitive || kind === 'expectation' || kind === 'count') {
			const inline = `{ ${entries.join(', ')} }`;
			if (!inline.includes('\n') && inline.length + depth * 4 <= INLINE_WIDTH) return inline;
		}
		const pad = '\t'.repeat(depth + 1);
		return `{\n${entries.map((e) => `${pad}${e},`).join('\n')}\n${'\t'.repeat(depth)}}`;
	}
}

function isRef(v: Json): boolean {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	const keys = Object.keys(v);
	return keys.length === 1 && (keys[0] === '$msg' || keys[0] === '$param');
}

function expectationKind(keys: string[]): string {
	return keys.includes('probe') ? 'probe' : 'expectation';
}

function tupleKind(kind: string, index: number): string {
	if (kind === 'count') return index === 0 ? 'target' : 'count';
	if (kind === 'text' || kind === 'value' || kind === 'checked')
		return index === 0 ? 'target' : 'plain';
	return kind;
}

function childKind(parent: string, key: string): string {
	switch (parent) {
		case 'journey':
			return key === 'steps' ? 'steps' : key === 'autostart' ? 'autostart' : 'plain';
		case 'step':
			if (key === 'target') return 'target';
			if (key === 'do' || key === 'say' || key === 'capture' || key === 'expect') return key;
			return 'plain';
		case 'target':
			return 'locator';
		case 'expectation':
		case 'probe':
			if (['visible', 'hidden', 'enabled', 'disabled'].includes(key)) return 'target';
			if (['text', 'value', 'checked', 'count'].includes(key)) return key;
			return 'plain';
		default:
			return 'plain';
	}
}

function orderKeys(keys: string[], kind: string): string[] {
	const order = KEY_ORDER[kind === 'target' ? 'locator' : kind];
	if (!order) return [...keys].sort();
	const known = order.filter((k) => keys.includes(k));
	const rest = keys.filter((k) => !order.includes(k)).sort();
	return [...known, ...rest];
}

function quote(s: string): string {
	const escaped = s
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
	return `'${escaped}'`;
}

export function print(ir: IR): string {
	const printer = new Printer();
	const body = printer.object(ir as unknown as { [k: string]: Json }, 'journey', 0);
	const helpers = ['defineJourney'];
	if (printer.usesMsg) helpers.push('msg');
	if (printer.usesParam) helpers.push('param');
	return `import { ${helpers.join(', ')} } from '@dorsk/journey';\n\nexport default defineJourney(${body});\n`;
}
