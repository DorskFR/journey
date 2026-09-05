import type { Draft } from './draft.js';

export const VARS_KEY = 'journey:vars';
const PREFIX = 'var.';

function refName(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) return null;
	const ref = (value as { $param?: unknown }).$param;
	return typeof ref === 'string' && ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : null;
}

export function varNames(draft: Draft): string[] {
	const names = new Set<string>();
	const add = (value: unknown): void => {
		const name = refName(value);
		if (name !== null) names.add(name);
	};
	for (const step of draft.steps) {
		if (step.do?.kind === 'fill' || step.do?.kind === 'select') add(step.do.value);
		for (const value of Object.values(step.params ?? {})) add(value);
		for (const s of step.suggestions) if ('value' in s.expectation) add(s.expectation.value[1]);
	}
	return Array.from(names).sort();
}

export function readVars(): Record<string, string> {
	try {
		const raw = sessionStorage.getItem(VARS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== 'object') return {};
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string' && value !== '') out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

export function writeVars(vars: Record<string, string>): void {
	try {
		sessionStorage.setItem(VARS_KEY, JSON.stringify(vars));
	} catch {}
}

export function varParams(vars: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(vars)) out[`${PREFIX}${name}`] = value;
	return out;
}
