import { parseTarget } from './target.js';
import type { Journey, ValidationError, ValidationResult } from './types.js';

const JOURNEY_KEYS = new Set([
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
]);
const STEP_KEYS = new Set([
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
]);
const LOCATOR_KEYS = new Set(['role', 'name', 'label', 'text', 'testid', 'css', 'within', 'nth']);
const INTERACTION_KEYS: Record<string, Set<string>> = {
	click: new Set(['kind']),
	dblclick: new Set(['kind']),
	hover: new Set(['kind']),
	none: new Set(['kind']),
	fill: new Set(['kind', 'value', 'mask']),
	select: new Set(['kind', 'value']),
	check: new Set(['kind', 'checked']),
	press: new Set(['kind', 'key']),
	navigate: new Set(['kind', 'url']),
};
const TARGET_EXPECTATIONS = new Set(['visible', 'hidden', 'enabled', 'disabled']);
const LEVELS = new Set(['smoke', 'checked', 'visual']);
const GUIDES = new Set(['wait-for-user', 'next']);

class Collector {
	errors: ValidationError[] = [];
	add(path: string, message: string): void {
		this.errors.push({ path, message });
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRef(v: unknown, key: '$msg' | '$param'): boolean {
	return isRecord(v) && Object.keys(v).length === 1 && typeof v[key] === 'string';
}

function checkString(c: Collector, path: string, v: unknown): boolean {
	if (typeof v === 'string') return true;
	c.add(path, `expected a string, got ${describe(v)}`);
	return false;
}

function describe(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'an array';
	if (typeof v === 'function') return 'a function';
	return typeof v === 'object' ? 'an object' : typeof v;
}

function checkKeys(
	c: Collector,
	path: string,
	v: Record<string, unknown>,
	allowed: Set<string>,
): void {
	for (const k of Object.keys(v)) {
		if (!allowed.has(k)) c.add(`${path}.${k}`, `unknown key "${k}"`);
	}
}

function checkNoFunctions(c: Collector, path: string, v: unknown): void {
	if (typeof v === 'function') {
		c.add(path, 'functions are not allowed');
	} else if (Array.isArray(v)) {
		v.forEach((item, i) => {
			checkNoFunctions(c, `${path}[${i}]`, item);
		});
	} else if (isRecord(v)) {
		for (const [k, item] of Object.entries(v)) checkNoFunctions(c, `${path}.${k}`, item);
	}
}

function checkText(c: Collector, path: string, v: unknown): void {
	if (typeof v === 'string' || isRef(v, '$msg')) return;
	if (isRecord(v)) {
		if (Object.keys(v).length === 0) c.add(path, 'locale map must not be empty');
		for (const [k, s] of Object.entries(v)) checkString(c, `${path}.${k}`, s);
		return;
	}
	c.add(path, `expected text (string, msg() or locale map), got ${describe(v)}`);
}

function checkPath(c: Collector, path: string, v: unknown): void {
	if (!checkString(c, path, v)) return;
	try {
		parseTarget(v as string);
	} catch (e) {
		c.add(path, (e as Error).message);
	}
}

function checkTarget(c: Collector, path: string, v: unknown): void {
	if (typeof v === 'string') {
		checkPath(c, path, v);
		return;
	}
	if (!isRecord(v)) {
		c.add(path, `expected a target path or locator, got ${describe(v)}`);
		return;
	}
	checkKeys(c, path, v, LOCATOR_KEYS);
	if (Object.keys(v).filter((k) => LOCATOR_KEYS.has(k)).length === 0) {
		c.add(path, 'locator must set at least one of role, name, label, text, testid, css');
	}
	for (const k of ['role', 'name', 'label', 'text', 'testid', 'css']) {
		if (k in v) checkString(c, `${path}.${k}`, v[k]);
	}
	if ('within' in v) checkPath(c, `${path}.within`, v.within);
	if ('nth' in v && !Number.isInteger(v.nth)) c.add(`${path}.nth`, 'expected an integer');
}

function checkValue(c: Collector, path: string, v: unknown): void {
	if (typeof v === 'string' || isRef(v, '$param')) return;
	c.add(path, `expected a string or param(), got ${describe(v)}`);
}

function checkInteraction(c: Collector, path: string, v: unknown): void {
	if (!isRecord(v)) {
		c.add(path, `expected an interaction object, got ${describe(v)}`);
		return;
	}
	const kind = v.kind;
	const allowed = typeof kind === 'string' ? INTERACTION_KEYS[kind] : undefined;
	if (!allowed) {
		c.add(`${path}.kind`, `unknown interaction kind ${JSON.stringify(kind)}`);
		return;
	}
	checkKeys(c, path, v, allowed);
	switch (kind) {
		case 'fill':
			checkValue(c, `${path}.value`, v.value);
			if ('mask' in v && typeof v.mask !== 'boolean') c.add(`${path}.mask`, 'expected a boolean');
			break;
		case 'select':
			checkValue(c, `${path}.value`, v.value);
			break;
		case 'check':
			if (typeof v.checked !== 'boolean') c.add(`${path}.checked`, 'expected a boolean');
			break;
		case 'press':
			checkString(c, `${path}.key`, v.key);
			break;
		case 'navigate':
			checkString(c, `${path}.url`, v.url);
			break;
	}
}

function checkPair(c: Collector, path: string, v: unknown): v is [unknown, unknown] {
	if (Array.isArray(v) && v.length === 2) return true;
	c.add(path, 'expected a [target, value] pair');
	return false;
}

function checkExpectation(c: Collector, path: string, v: unknown): void {
	if (!isRecord(v)) {
		c.add(path, `expected an expectation object, got ${describe(v)}`);
		return;
	}
	const keys = Object.keys(v);
	const kind = keys[0];
	if (kind === 'probe') {
		checkKeys(c, path, v, new Set(['probe', 'equals']));
		checkString(c, `${path}.probe`, v.probe);
		return;
	}
	if (keys.length !== 1 || kind === undefined) {
		c.add(path, `expected exactly one expectation key, got ${JSON.stringify(keys)}`);
		return;
	}
	const value = v[kind];
	const p = `${path}.${kind}`;
	if (TARGET_EXPECTATIONS.has(kind)) {
		checkTarget(c, p, value);
		return;
	}
	switch (kind) {
		case 'url':
		case 'event':
			checkString(c, p, value);
			return;
		case 'text':
			if (checkPair(c, p, value)) {
				checkTarget(c, `${p}[0]`, value[0]);
				checkText(c, `${p}[1]`, value[1]);
			}
			return;
		case 'value':
			if (checkPair(c, p, value)) {
				checkTarget(c, `${p}[0]`, value[0]);
				checkValue(c, `${p}[1]`, value[1]);
			}
			return;
		case 'checked':
			if (checkPair(c, p, value)) {
				checkTarget(c, `${p}[0]`, value[0]);
				if (typeof value[1] !== 'boolean') c.add(`${p}[1]`, 'expected a boolean');
			}
			return;
		case 'count':
			if (checkPair(c, p, value)) {
				checkTarget(c, `${p}[0]`, value[0]);
				const opts = value[1];
				if (!isRecord(opts)) {
					c.add(`${p}[1]`, 'expected { min?, max?, equals? }');
					return;
				}
				checkKeys(c, `${p}[1]`, opts, new Set(['min', 'max', 'equals']));
				for (const k of ['min', 'max', 'equals']) {
					if (k in opts && !Number.isInteger(opts[k])) c.add(`${p}[1].${k}`, 'expected an integer');
				}
				if (Object.keys(opts).length === 0)
					c.add(`${p}[1]`, 'expected at least one of min, max, equals');
			}
			return;
		default:
			c.add(path, `unknown expectation "${kind}"`);
	}
}

function checkStringRecord(c: Collector, path: string, v: unknown, allowParam = false): void {
	if (!isRecord(v)) {
		c.add(path, `expected an object, got ${describe(v)}`);
		return;
	}
	for (const [k, item] of Object.entries(v)) {
		if (allowParam) checkValue(c, `${path}.${k}`, item);
		else checkString(c, `${path}.${k}`, item);
	}
}

function checkCapture(c: Collector, path: string, v: unknown): void {
	if (typeof v === 'string') {
		if (v === '') c.add(path, 'capture name must not be empty');
		return;
	}
	if (!isRecord(v)) {
		c.add(path, `expected a capture name or object, got ${describe(v)}`);
		return;
	}
	checkKeys(c, path, v, new Set(['name', 'video', 'crop']));
	checkString(c, `${path}.name`, v.name);
	if ('video' in v && typeof v.video !== 'boolean') c.add(`${path}.video`, 'expected a boolean');
	if ('crop' in v && v.crop !== 'none' && v.crop !== 'target') checkPath(c, `${path}.crop`, v.crop);
}

function checkStep(c: Collector, path: string, v: unknown): void {
	if (!isRecord(v)) {
		c.add(path, `expected a step object, got ${describe(v)}`);
		return;
	}
	checkKeys(c, path, v, STEP_KEYS);
	if (checkString(c, `${path}.id`, v.id) && v.id === '') c.add(`${path}.id`, 'step id is required');
	if ('route' in v) checkString(c, `${path}.route`, v.route);
	if ('target' in v) checkTarget(c, `${path}.target`, v.target);
	if ('params' in v) checkStringRecord(c, `${path}.params`, v.params, true);
	if ('do' in v) checkInteraction(c, `${path}.do`, v.do);
	if ('guide' in v && !GUIDES.has(v.guide as string)) {
		c.add(`${path}.guide`, `expected 'wait-for-user' or 'next'`);
	}
	if ('say' in v) {
		if (!isRecord(v.say))
			c.add(`${path}.say`, `expected { title?, body? }, got ${describe(v.say)}`);
		else {
			checkKeys(c, `${path}.say`, v.say, new Set(['title', 'body']));
			if ('title' in v.say) checkText(c, `${path}.say.title`, v.say.title);
			if ('body' in v.say) checkText(c, `${path}.say.body`, v.say.body);
		}
	}
	if ('expect' in v) {
		if (!Array.isArray(v.expect))
			c.add(`${path}.expect`, `expected an array, got ${describe(v.expect)}`);
		else {
			v.expect.forEach((e, i) => {
				checkExpectation(c, `${path}.expect[${i}]`, e);
			});
		}
	}
	if ('capture' in v) checkCapture(c, `${path}.capture`, v.capture);
	if ('when' in v) checkStringRecord(c, `${path}.when`, v.when);
	if ('optional' in v && typeof v.optional !== 'boolean')
		c.add(`${path}.optional`, 'expected a boolean');
	if ('timeout' in v && !(typeof v.timeout === 'number' && v.timeout >= 0)) {
		c.add(`${path}.timeout`, 'expected a non-negative number');
	}
	if ('qaOnly' in v && typeof v.qaOnly !== 'boolean') c.add(`${path}.qaOnly`, 'expected a boolean');
	const kind = isRecord(v.do) ? v.do.kind : 'none';
	if (kind !== 'none' && kind !== 'navigate' && !('target' in v)) {
		c.add(`${path}.target`, `a target is required for do.kind "${String(kind)}"`);
	}
}

export function validate(journey: unknown): ValidationResult {
	const c = new Collector();
	if (!isRecord(journey)) {
		c.add('', `expected a journey object, got ${describe(journey)}`);
		return { ok: false, errors: c.errors };
	}
	checkNoFunctions(c, '', journey);
	if (c.errors.length > 0) return { ok: false, errors: c.errors.map(stripLeadingDot) };
	checkKeys(c, '', journey, JOURNEY_KEYS);
	if (checkString(c, 'id', journey.id) && journey.id === '') c.add('id', 'journey id is required');
	if ('version' in journey && !Number.isInteger(journey.version))
		c.add('version', 'expected an integer');
	if ('title' in journey) checkText(c, 'title', journey.title);
	if ('description' in journey) checkText(c, 'description', journey.description);
	if ('route' in journey) checkString(c, 'route', journey.route);
	if ('variants' in journey) {
		if (!isRecord(journey.variants)) c.add('variants', 'expected an object of string arrays');
		else {
			for (const [dim, values] of Object.entries(journey.variants)) {
				if (!Array.isArray(values)) c.add(`variants.${dim}`, 'expected an array of strings');
				else {
					values.forEach((s, i) => {
						checkString(c, `variants.${dim}[${i}]`, s);
					});
				}
			}
		}
	}
	if ('fixture' in journey) checkString(c, 'fixture', journey.fixture);
	if ('mask' in journey) {
		if (!Array.isArray(journey.mask)) c.add('mask', 'expected an array of target paths');
		else {
			journey.mask.forEach((p, i) => {
				checkPath(c, `mask[${i}]`, p);
			});
		}
	}
	if ('level' in journey && !LEVELS.has(journey.level as string)) {
		c.add('level', `expected 'smoke', 'checked' or 'visual'`);
	}
	if ('autostart' in journey) {
		if (!isRecord(journey.autostart)) c.add('autostart', 'expected { route, once? }');
		else {
			checkKeys(c, 'autostart', journey.autostart, new Set(['route', 'once']));
			checkString(c, 'autostart.route', journey.autostart.route);
			if ('once' in journey.autostart && typeof journey.autostart.once !== 'boolean') {
				c.add('autostart.once', 'expected a boolean');
			}
		}
	}
	if (!('steps' in journey)) c.add('steps', 'steps is required');
	else if (!Array.isArray(journey.steps))
		c.add('steps', `expected an array, got ${describe(journey.steps)}`);
	else {
		const seen = new Map<string, number>();
		journey.steps.forEach((step, i) => {
			checkStep(c, `steps[${i}]`, step);
			const id = isRecord(step) ? step.id : undefined;
			if (typeof id !== 'string') return;
			const first = seen.get(id);
			if (first !== undefined)
				c.add(`steps[${i}].id`, `duplicate step id "${id}" (first at steps[${first}])`);
			else seen.set(id, i);
		});
	}
	return { ok: c.errors.length === 0, errors: c.errors.map(stripLeadingDot) };
}

function stripLeadingDot(e: ValidationError): ValidationError {
	return e.path.startsWith('.') ? { path: e.path.slice(1), message: e.message } : e;
}

export function assertValid(journey: unknown): asserts journey is Journey {
	const result = validate(journey);
	if (result.ok) return;
	const lines = result.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`);
	throw new Error(`Invalid journey:\n${lines.join('\n')}`);
}
