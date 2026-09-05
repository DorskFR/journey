import type * as Runtime from '../runtime/index.js';

export type RuntimeGlobal = Pick<
	typeof Runtime,
	'resolveOne' | 'resolveAll' | 'resolvePath' | 'accessibleName' | 'computedRole' | 'isVisible'
>;

export function runtime(): RuntimeGlobal {
	const global = (window as unknown as { journeyRuntime?: RuntimeGlobal }).journeyRuntime;
	if (!global) throw new Error('journey: the runtime bundle must be loaded before the editor');
	return global;
}

export function currentRoute(): string {
	return location.pathname + location.hash;
}

export function collapse(text: string | null | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim();
}
