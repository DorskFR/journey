import type { Expectation, Interaction, Step, Target } from '../core/types.js';
import type { Health } from './locate.js';

export interface Suggestion {
	label: string;
	expectation: Expectation;
	accepted: boolean;
}

export interface DraftStep extends Step {
	health: Health;
	suggestions: Suggestion[];
}

export interface Draft {
	id: string;
	title: string;
	route: string;
	steps: DraftStep[];
}

export type StepResult = 'pass' | 'fail' | 'skip';

export type Dock = 'right' | 'left';

export interface DraftState {
	draft: Draft;
	recording: boolean;
	lastRoute: string;
	results: Record<number, StepResult>;
	collapsed: boolean;
	dock: Dock;
}

export const STORAGE_KEY = 'journey:draft';

export function emptyDraft(): Draft {
	return { id: 'my-journey', title: '', route: '/', steps: [] };
}

export function readState(): DraftState | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<DraftState>;
		if (!parsed.draft || !Array.isArray(parsed.draft.steps)) return null;
		return {
			draft: { ...emptyDraft(), ...parsed.draft },
			recording: parsed.recording === true,
			lastRoute: typeof parsed.lastRoute === 'string' ? parsed.lastRoute : '',
			results: parsed.results ?? {},
			collapsed: parsed.collapsed === true,
			dock: parsed.dock === 'left' ? 'left' : 'right',
		};
	} catch {
		return null;
	}
}

export function writeState(state: DraftState): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {}
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function baseId(
	target: Target | undefined,
	action: Interaction,
	route: string | undefined,
): string {
	if (action.kind === 'none') return `go-${slug(route ?? '') || 'home'}`;
	if (typeof target === 'string') {
		const last = target.split('/').pop() ?? target;
		return slug(last.replace(/\[.*\]$/, '')) || action.kind;
	}
	const hint = target?.testid ?? target?.label ?? target?.name ?? target?.text;
	return (hint === undefined ? '' : slug(hint)) || action.kind;
}

export function stepId(
	target: Target | undefined,
	action: Interaction,
	route: string | undefined,
	existing: DraftStep[],
): string {
	const base = baseId(target, action, route);
	const taken = new Set(existing.map((s) => s.id));
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n += 1;
	return `${base}-${n}`;
}

export function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
