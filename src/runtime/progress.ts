import type { IR } from '../core/types.js';
import { defaultStorage, type JourneyStorage } from './storage.js';

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

export async function readProgress(
	storage: JourneyStorage = defaultStorage,
): Promise<Progress | null> {
	try {
		const raw = await storage.get(PROGRESS_KEY);
		if (raw === null || raw === undefined) return null;
		const parsed = JSON.parse(raw) as Progress;
		return typeof parsed === 'object' && parsed !== null && typeof parsed.id === 'string'
			? parsed
			: null;
	} catch {
		return null;
	}
}

export async function writeProgress(
	progress: Progress,
	storage: JourneyStorage = defaultStorage,
): Promise<void> {
	try {
		await storage.set(PROGRESS_KEY, JSON.stringify(progress));
	} catch {}
}

export async function clearProgress(storage: JourneyStorage = defaultStorage): Promise<void> {
	try {
		await storage.remove(PROGRESS_KEY);
	} catch {}
}
