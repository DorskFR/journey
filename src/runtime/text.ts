import type { ParamRef, Text } from '../core/types.js';

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
