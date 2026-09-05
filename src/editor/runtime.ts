import type * as Runtime from '../runtime/index.js';

export type RuntimeGlobal = Pick<
	typeof Runtime,
	'resolveOne' | 'resolveAll' | 'resolvePath' | 'accessibleName' | 'computedRole' | 'isVisible'
>;

let current: RuntimeGlobal | null = null;

export function useRuntime(resolvers: RuntimeGlobal): void {
	current = resolvers;
}

export function runtime(): RuntimeGlobal {
	const global = (window as unknown as { journeyRuntime?: RuntimeGlobal }).journeyRuntime;
	const found = current ?? window.__journey?.resolve ?? global;
	if (!found) throw new Error('journey: mount the runtime before the editor');
	return found;
}

export function currentRoute(): string {
	return location.pathname + location.hash;
}

export function collapse(text: string | null | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim();
}
