import type { IR } from '../core/types.js';
import { SENSITIVE_NAME } from '../core/validate.js';
import { defaultStorage, type JourneyStorage } from './storage.js';

export const PROGRESS_KEY = 'journey:progress';

export interface Progress {
	id: string;
	version: number;
	index: number;
	mode: string;
	params: Record<string, string>;
	variant: Record<string, string>;
	acted?: boolean;
	navigated?: boolean;
}

function maskedParams(ir: IR): Set<string> {
	const names = new Set<string>();
	for (const step of ir.steps) {
		const action = step.do;
		if (action.kind === 'fill' && action.mask === true && typeof action.value === 'object') {
			names.add(action.value.$param);
		}
	}
	return names;
}

export function storedParams(
	ir: IR,
	params: Record<string, string> | undefined,
): Record<string, string> {
	const masked = maskedParams(ir);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params ?? {})) {
		if (key.startsWith('var.') || SENSITIVE_NAME.test(key) || masked.has(key)) continue;
		out[key] = value;
	}
	return out;
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
