import { glob } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config, IR } from '../core/types.js';
import { BUILTIN_VIEWPORTS, type Viewport } from '../playwright/driver.js';

export const DEFAULT_CONFIG = 'journey.config.ts';
export const DEFAULT_JOURNEYS = 'journeys/**/*.journey.ts';
export const DEFAULT_OUT = 'docs/journeys';

export interface LoadedConfig {
	config: Config;
	path: string;
	dir: string;
}

export function configPath(path?: string): string {
	return resolve(path ?? process.env.JOURNEY_CONFIG ?? DEFAULT_CONFIG);
}

export async function loadConfig(path?: string): Promise<LoadedConfig> {
	const abs = configPath(path);
	const mod = (await import(pathToFileURL(abs).href)) as { default?: Config };
	const config = mod.default;
	if (!config || typeof config !== 'object') {
		throw new Error(`journey: ${abs} has no default export`);
	}
	return { config, path: abs, dir: dirname(abs) };
}

export function resolveFrom(loaded: LoadedConfig, path: string): string {
	return isAbsolute(path) ? path : resolve(loaded.dir, path);
}

export function outDir(loaded: LoadedConfig): string {
	return resolveFrom(loaded, loaded.config.out ?? DEFAULT_OUT);
}

export function baseUrl(loaded: LoadedConfig): string {
	const url = loaded.config.app?.url;
	if (!url) throw new Error('journey: config.app.url is required');
	return url;
}

export async function journeyFiles(loaded: LoadedConfig): Promise<string[]> {
	const patterns = loaded.config.journeys ?? DEFAULT_JOURNEYS;
	const list = Array.isArray(patterns) ? patterns : [patterns];
	const files = new Set<string>();
	for (const pattern of list) {
		for await (const file of glob(pattern, { cwd: loaded.dir })) {
			files.add(resolve(loaded.dir, file));
		}
	}
	return Array.from(files).sort();
}

export function variantNames(config: Config): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [dim, values] of Object.entries(config.variants ?? {})) {
		out[dim] = Array.isArray(values) ? values : Object.keys(values);
	}
	return out;
}

export function viewports(config: Config): Record<string, Viewport> {
	const declared = config.variants?.viewport;
	if (!declared || Array.isArray(declared)) return BUILTIN_VIEWPORTS;
	const out: Record<string, Viewport> = { ...BUILTIN_VIEWPORTS };
	for (const [name, value] of Object.entries(declared)) {
		const v = value as Partial<Viewport>;
		if (typeof v?.width === 'number' && typeof v.height === 'number') {
			out[name] = { width: v.width, height: v.height };
		}
	}
	return out;
}

export function variantMatrix(config: Config, ir: IR): Array<Record<string, string>> {
	const dims = variantNames(config);
	const axes: Array<[string, string[]]> = [];
	for (const [dim, values] of Object.entries(dims)) {
		const wanted = ir.variants?.[dim] ?? values.slice(0, 1);
		if (wanted.length) axes.push([dim, wanted]);
	}
	for (const [dim, values] of Object.entries(ir.variants ?? {})) {
		if (!(dim in dims) && values.length) axes.push([dim, values]);
	}
	if (!axes.length) return [{ viewport: 'desktop' }];
	let combos: Array<Record<string, string>> = [{}];
	for (const [dim, values] of axes) {
		combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [dim]: value })));
	}
	return combos;
}

export function variantKey(variant: Record<string, string>): string {
	return Object.values(variant).join('-');
}

export function variantLabel(variant: Record<string, string>): string {
	return Object.entries(variant)
		.map(([dim, value]) => `${dim}=${value}`)
		.join(' ');
}
