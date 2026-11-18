import { parseTarget } from '../core/target.js';
import type { Expectation, IR, ParamRef, Target, Text } from '../core/types.js';

export type Params = Record<string, string>;
export type Translate = (id: string, locale: string) => string | undefined;

export function currentLocale(variant: Record<string, string> = {}): string | undefined {
	const lang = typeof document === 'undefined' ? '' : document.documentElement.lang;
	return variant.locale ?? (lang === '' ? undefined : lang);
}

export function resolveText(
	text: Text | undefined,
	translate: Translate | undefined,
	locale: string | undefined,
): string | undefined {
	if (text === undefined) return undefined;
	if (typeof text === 'string') return text;
	if ('$msg' in text && typeof text.$msg === 'string') {
		const id = text.$msg;
		return translate?.(id, locale ?? 'en') ?? id;
	}
	const table = text as Record<string, string>;
	const keys = Object.keys(table);
	for (const candidate of [locale, 'en']) {
		if (candidate !== undefined && candidate !== '' && table[candidate] !== undefined) {
			return table[candidate];
		}
	}
	const first = keys[0];
	return first === undefined ? undefined : table[first];
}

export function isParamRef(value: unknown): value is ParamRef {
	return (
		typeof value === 'object' && value !== null && typeof (value as ParamRef).$param === 'string'
	);
}

export function resolveParam(value: string | ParamRef, params: Params): string {
	if (typeof value === 'string') return value;
	const resolved = params[value.$param];
	if (resolved === undefined) throw new Error(`Unresolved param "${value.$param}"`);
	return resolved;
}

export function resolveStepParams(
	stepParams: Record<string, string | ParamRef> | undefined,
	params: Params,
): Params {
	const out: Params = {};
	for (const [key, value] of Object.entries(stepParams ?? {}))
		out[key] = resolveParam(value, params);
	return out;
}

export interface ParamPlan {
	ask: string[];
	missing: { stepId: string; param: string } | null;
}

function expectationTarget(e: Expectation): Target | undefined {
	if ('visible' in e) return e.visible;
	if ('hidden' in e) return e.hidden;
	if ('enabled' in e) return e.enabled;
	if ('disabled' in e) return e.disabled;
	if ('text' in e) return e.text[0];
	if ('value' in e) return e.value[0];
	if ('checked' in e) return e.checked[0];
	if ('count' in e) return e.count[0];
	return undefined;
}

function targetParams(target: Target | undefined): string[] {
	const path = typeof target === 'string' ? target : target?.within;
	if (path === undefined) return [];
	return parseTarget(path).segments.flatMap((s) => (s.param === undefined ? [] : [s.param]));
}

/**
 * The params a run from `from` reads but nobody supplied. With `human`, a
 * fill or select param the user is first asked to type is not missing: it
 * goes to `ask` and is available to the steps after it.
 */
export function planParams(
	ir: IR,
	params: Params,
	opts: { from?: number; variant?: Record<string, string>; human?: boolean } = {},
): ParamPlan {
	const known = new Set(Object.keys(params));
	const ask: string[] = [];
	const variant = opts.variant ?? {};
	for (const step of ir.steps.slice(opts.from ?? 0)) {
		if (Object.entries(step.when ?? {}).some(([dim, value]) => variant[dim] !== value)) continue;
		const local = new Set(known);
		const lacking = (name: string, scope: Set<string>) =>
			scope.has(name) ? null : { stepId: step.id, param: name };
		for (const value of Object.values(step.params ?? {})) {
			if (!isParamRef(value)) continue;
			const miss = lacking(value.$param, known);
			if (miss) return { ask, missing: miss };
		}
		for (const key of Object.keys(step.params ?? {})) local.add(key);
		for (const name of targetParams(step.target)) {
			const miss = lacking(name, local);
			if (miss) return { ask, missing: miss };
		}
		const action = step.do;
		if ((action.kind === 'fill' || action.kind === 'select') && isParamRef(action.value)) {
			const name = action.value.$param;
			if (!local.has(name)) {
				if (!opts.human) return { ask, missing: { stepId: step.id, param: name } };
				ask.push(name);
				known.add(name);
				local.add(name);
			}
		}
		for (const e of step.expect ?? []) {
			const names = targetParams(expectationTarget(e));
			if ('value' in e && isParamRef(e.value[1])) names.push(e.value[1].$param);
			for (const name of names) {
				const miss = lacking(name, local);
				if (miss) return { ask, missing: miss };
			}
		}
	}
	return { ask, missing: null };
}
