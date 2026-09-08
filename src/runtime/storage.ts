export interface JourneyStorage {
	get(key: string): string | null | Promise<string | null>;
	set(key: string, value: string): void | Promise<void>;
	remove(key: string): void | Promise<void>;
}

export const DONE_PREFIX = 'journey:done:';

const memory = new Map<string, string>();

// Resume is per tab; the completion marker is per browser.
function area(key: string): Storage {
	return key.startsWith(DONE_PREFIX) ? localStorage : sessionStorage;
}

export const defaultStorage: JourneyStorage = {
	get(key) {
		try {
			return area(key).getItem(key);
		} catch {
			return memory.get(key) ?? null;
		}
	},
	set(key, value) {
		try {
			area(key).setItem(key, value);
		} catch {
			memory.set(key, value);
		}
	},
	remove(key) {
		try {
			area(key).removeItem(key);
		} catch {
			memory.delete(key);
		}
	},
};
