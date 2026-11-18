import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Config, TargetPath } from '../core/types.js';
import { retryScreenshot } from '../playwright/capture.js';
import { ensureMounted, errorLine, startUrl } from '../playwright/driver.js';
import { applyFixture, applyStorageState, storageStatePath } from '../playwright/fixtures.js';
import { injectRuntime } from '../playwright/inject.js';
import { withAppBrowser } from './app.js';
import {
	baseUrl,
	type LoadedConfig,
	loadConfig,
	outDir,
	variantKey,
	variantNames,
	viewports,
} from './config.js';
import { type Argv, flagString, launchOptions } from './main.js';

export interface PageEntry {
	route: string;
	name: string;
	fixture?: string;
	variants: Array<Record<string, string>>;
}

type PageSpec = Exclude<NonNullable<Config['pages']>[number], string> & { fixture?: string };

export const NETWORK_IDLE_TIMEOUT = 5000;

export function pageName(route: string): string {
	const url = new URL(route, 'http://journey.invalid');
	const path = url.pathname.replace(/\.[a-z0-9]+$/i, '');
	const name = [path, url.search.slice(1), url.hash.slice(1)]
		.join('-')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return name || 'home';
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function combinations(dims: Record<string, string[]>): Array<Record<string, string>> {
	const axes = Object.entries(dims).filter(([, values]) => values.length);
	if (!axes.length) return [{ viewport: 'desktop' }];
	let combos: Array<Record<string, string>> = [{}];
	for (const [dim, values] of axes) {
		combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [dim]: value })));
	}
	return combos;
}

export function pageEntries(config: Config): PageEntry[] {
	const configDims = variantNames(config);
	const routes = new Map<string, string>();
	return (config.pages ?? []).map((entry) => {
		const spec: PageSpec = typeof entry === 'string' ? { route: entry } : entry;
		if (spec.fixture !== undefined && !config.fixtures?.[spec.fixture]) {
			throw new Error(
				`journey pages: fixture "${spec.fixture}" of ${spec.route} is not defined in the config`,
			);
		}
		const name = spec.name ?? pageName(spec.route);
		if (!SAFE_NAME.test(name)) {
			throw new Error(
				`journey pages: name "${name}" of ${spec.route} must start with a letter or digit and use only letters, digits, ".", "_" or "-"`,
			);
		}
		const taken = routes.get(name.toLowerCase());
		if (taken !== undefined) {
			throw new Error(
				`journey pages: ${taken} and ${spec.route} are both named "${name}", give one a \`name\``,
			);
		}
		routes.set(name.toLowerCase(), spec.route);
		const variants = combinations(spec.variants ?? configDims);
		return spec.fixture === undefined
			? { route: spec.route, name, variants }
			: { route: spec.route, name, fixture: spec.fixture, variants };
	});
}

export function renderPagesIndex(
	pages: Array<{ name: string; route: string; keys: string[] }>,
): string {
	const lines: string[] = ['# Pages', ''];
	for (const page of pages) {
		lines.push(`## ${page.name}`, '', `Route: \`${page.route}\``, '');
		lines.push(`| ${page.keys.join(' | ')} |`);
		lines.push(`| ${page.keys.map(() => '---').join(' | ')} |`);
		lines.push(`| ${page.keys.map((key) => `![${key}](${page.name}/${key}.png)`).join(' | ')} |`);
		lines.push('');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

export async function settlePage(page: Page): Promise<void> {
	await page
		.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT })
		.catch(() => undefined);
	await page.evaluate(() => document.fonts.ready);
}

export async function applyMasks(
	page: Page,
	masks: TargetPath[],
	params: Record<string, string>,
): Promise<void> {
	if (!masks.length) return;
	await page.evaluate(
		([paths, p]) => {
			const runtime = (
				window as unknown as {
					journeyRuntime: { Masker: new () => { apply(m: string[], p: object): void } };
				}
			).journeyRuntime;
			new runtime.Masker().apply(paths, p);
		},
		[masks, params] as const,
	);
}

async function shoot(
	loaded: LoadedConfig,
	page: Page,
	entry: PageEntry,
	variant: Record<string, string>,
	file: string,
): Promise<void> {
	const url = baseUrl(loaded);
	const storage = storageStatePath(entry.fixture, loaded.config, loaded.dir);
	if (storage) await applyStorageState(page.context(), storage);
	const fixture = await applyFixture(entry.fixture, loaded.config, {
		baseUrl: url,
		context: page.context(),
		request: page.request,
		configDir: loaded.dir,
	});
	try {
		await page.goto(startUrl(url, entry.route));
		await ensureMounted(page);
		for (const [dim, value] of Object.entries(variant)) {
			if (dim === 'viewport') continue;
			await page.evaluate(([d, v]) => window.__journey?.applyVariant(d, v), [dim, value] as const);
		}
		const params: Record<string, string> = { ...fixture.params };
		for (const [dim, value] of Object.entries(variant)) params[`variant.${dim}`] = value;
		await settlePage(page);
		await applyMasks(page, loaded.config.mask ?? [], params);
		writeFileSync(
			file,
			await retryScreenshot(page, { type: 'png', animations: 'disabled', caret: 'hide' }),
		);
	} finally {
		await fixture.stop();
	}
}

export async function runPages(argv: Argv): Promise<number> {
	const loaded = await loadConfig(flagString(argv, 'config'));
	const entries = pageEntries(loaded.config);
	if (!entries.length) {
		console.error('journey pages: config.pages is empty');
		return 1;
	}
	const out = join(outDir(loaded), 'pages');
	const sizes = viewports(loaded.config);
	const launch = launchOptions(argv);
	let failed = 0;
	const index: Array<{ name: string; route: string; keys: string[] }> = [];
	await withAppBrowser(loaded, launch, async (browser) => {
		for (const entry of entries) {
			const dir = join(out, entry.name);
			mkdirSync(dir, { recursive: true });
			const keys: string[] = [];
			for (const variant of entry.variants) {
				const key = variantKey(variant);
				const viewport = sizes[variant.viewport ?? 'desktop'];
				const context = await browser.newContext(viewport ? { viewport } : {});
				await injectRuntime(context);
				const page = await context.newPage();
				let ok = true;
				let error = '';
				try {
					await shoot(loaded, page, entry, variant, join(dir, `${key}.png`));
					keys.push(key);
				} catch (e) {
					ok = false;
					error = errorLine(e);
				} finally {
					await context.close();
				}
				if (!ok) failed += 1;
				console.log(
					`${ok ? '✓' : '✗'} ${entry.name} [${key}] ${join(dir, `${key}.png`)}${error ? ` ${error}` : ''}`,
				);
			}
			index.push({ name: entry.name, route: entry.route, keys });
		}
		writeFileSync(join(out, 'index.md'), renderPagesIndex(index));
	});
	return failed ? 1 : 0;
}
