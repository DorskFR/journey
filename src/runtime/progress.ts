import type { IR } from '../core/types.js';

export const PROGRESS_KEY = 'journey:progress';

export interface Progress {
	id: string;
	version: number;
	index: number;
	mode: string;
	params: Record<string, string>;
	variant: Record<string, string>;
	ir: IR;
	acted?: boolean;
	navigated?: boolean;
}

export function readProgress(): Progress | null {
	try {
		const raw = sessionStorage.getItem(PROGRESS_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as Progress;
		return typeof parsed === 'object' && parsed !== null && typeof parsed.id === 'string'
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function writeProgress(progress: Progress): void {
	try {
		sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
	} catch {}
}

export function clearProgress(): void {
	try {
		sessionStorage.removeItem(PROGRESS_KEY);
	} catch {}
}
