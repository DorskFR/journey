import { glob } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config, IR, TestConfig } from '../core/types.js';
import { BUILTIN_VIEWPORTS, type Viewport } from '../playwright/driver.js';

export const DEFAULT_CONFIG = 'journey.config.ts';
export const DEFAULT_JOURNEYS = 'journeys/**/*.journey.ts';
export const DEFAULT_OUT = 'docs/journeys';
export const REPEAT_SEPARATOR = ',';

export interface LoadedConfig {
	config: Config;
	path: string;
	dir: string;
}

export function configPath(path?: string): string {
	return resolve(path ?? process.env.JOURNEY_CONFIG ?? DEFAULT_CONFIG);
}

export function envVars(raw = process.env.JOURNEY_VARS): Record<string, string> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`journey: JOURNEY_VARS is not valid JSON: ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('journey: JOURNEY_VARS must be a JSON object');
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) out[key] = String(value);
	return out;
}

export function withEnvVars(config: Config, env = envVars()): Config {
	if (Object.keys(env).length === 0) return config;
	return { ...config, vars: { ...config.vars, ...env } };
}

type Importer = (file: string) => Promise<unknown>;

export const STRIP_ONLY_HINT =
	'TypeScript is loaded with Node type stripping because @playwright/test is not installed: ' +
	'write relative imports with their .ts extension, and avoid enums, namespaces, parameter properties and tsconfig paths. ' +
	'Install @playwright/test to load it like `journey test` does.';

let playwrightImporter: Importer | null | undefined;

function findPlaywrightImporter(): Importer | null {
	try {
		const fromJourney = createRequire(import.meta.url);
		const fromTest = createRequire(fromJourney.resolve('@playwright/test/package.json'));
		const common = fromTest('playwright/lib/common') as {
			transform?: { requireOrImport?: unknown };
		};
		const requireOrImport = common.transform?.requireOrImport;
		return typeof requireOrImport === 'function' ? (requireOrImport as Importer) : null;
	} catch {
		return null;
	}
}

export async function importUserFile(file: string): Promise<unknown> {
	playwrightImporter ??= findPlaywrightImporter();
	if (playwrightImporter) return playwrightImporter(file);
	try {
		return await import(pathToFileURL(file).href);
	} catch (error) {
		if (!/\.[cm]?tsx?$/.test(file)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message}\n${STRIP_ONLY_HINT}`, { cause: error });
	}
}

export async function loadConfig(path?: string): Promise<LoadedConfig> {
	const abs = configPath(path);
	const config = importDefault<Config>(await importUserFile(abs));
	if (!config || typeof config !== 'object') {
		throw new Error(`journey: ${abs} has no default export`);
	}
	return { config: withEnvVars(config), path: abs, dir: dirname(abs) };
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

export function journeysDir(loaded: LoadedConfig): string {
	const patterns = loaded.config.journeys ?? DEFAULT_JOURNEYS;
	const first = (Array.isArray(patterns) ? patterns[0] : patterns) ?? DEFAULT_JOURNEYS;
	const parts = first.split('/');
	const fixed = parts.slice(0, -1);
	const glob = fixed.findIndex((part) => /[*?[\]{}!]/.test(part));
	return resolveFrom(loaded, (glob < 0 ? fixed : fixed.slice(0, glob)).join('/') || '.');
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

export function importDefault<T>(mod: unknown): T | undefined {
	let value = (mod as { default?: unknown }).default;
	while (
		value !== null &&
		typeof value === 'object' &&
		'__esModule' in value &&
		'default' in value
	) {
		value = (value as { default?: unknown }).default;
	}
	return value as T | undefined;
}

export type VariantFilter = Record<string, string[]>;

export function parseVariantFilter(value: string | undefined, command: string): VariantFilter {
	const out: VariantFilter = {};
	for (const part of (value ?? '').split(REPEAT_SEPARATOR)) {
		if (!part) continue;
		const eq = part.indexOf('=');
		if (eq <= 0) throw new Error(`journey ${command}: --variant expects dim=value, got "${part}"`);
		const dim = part.slice(0, eq);
		const values = out[dim] ?? [];
		const wanted = part.slice(eq + 1);
		if (!values.includes(wanted)) values.push(wanted);
		out[dim] = values;
	}
	return out;
}

export function matchesFilter(variant: Record<string, string>, filter: VariantFilter): boolean {
	return Object.entries(filter).every(([dim, values]) => values.includes(variant[dim] ?? ''));
}

export function checkVariantFilter(
	filter: VariantFilter,
	matrices: Array<Array<Record<string, string>>>,
	command: string,
): void {
	if (!Object.keys(filter).length) return;
	const known = new Map<string, Set<string>>();
	for (const variant of matrices.flat()) {
		for (const [dim, value] of Object.entries(variant)) {
			known.set(dim, (known.get(dim) ?? new Set<string>()).add(value));
		}
	}
	for (const [dim, values] of Object.entries(filter)) {
		const valid = known.get(dim);
		if (!valid) {
			throw new Error(
				`journey ${command}: unknown variant dim "${dim}", expected one of: ${[...known.keys()].join(', ')}`,
			);
		}
		const unknown = values.filter((value) => !valid.has(value));
		if (unknown.length) {
			throw new Error(
				`journey ${command}: unknown ${dim} ${unknown.map((v) => `"${v}"`).join(', ')}, expected one of: ${[...valid].join(', ')}`,
			);
		}
	}
	if (!matrices.flat().some((variant) => matchesFilter(variant, filter))) {
		const asked = Object.entries(filter)
			.map(([dim, values]) => `${dim}=${values.join('|')}`)
			.join(' ');
		throw new Error(
			`journey ${command}: no variant of the selected journeys matches --variant ${asked}`,
		);
	}
}

export function selectById<T extends { ir: IR }>(
	entries: T[],
	ids: string[],
	command: string,
): T[] {
	if (!ids.length) return entries;
	const missing = ids.filter((id) => !entries.some((entry) => entry.ir.id === id));
	if (missing.length) {
		throw new Error(
			`journey ${command}: ${missing.map((id) => `"${id}"`).join(', ')} not among the configured journeys: ${entries.map((e) => e.ir.id).join(', ')}`,
		);
	}
	return entries.filter((entry) => ids.includes(entry.ir.id));
}

const TEST_OPTIONS = [
	'retries',
	'workers',
	'fullyParallel',
	'timeout',
	'maxFailures',
	'forbidOnly',
	'expect',
] as const;

export function testSettings(config: Config): {
	options: Omit<TestConfig, 'use'>;
	use: NonNullable<TestConfig['use']>;
} {
	const test = config.test ?? {};
	const options: Record<string, unknown> = {};
	for (const key of TEST_OPTIONS) if (test[key] !== undefined) options[key] = test[key];
	return { options, use: { ...test.use } };
}
