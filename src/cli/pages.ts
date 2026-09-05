import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Config } from '../core/types.js';
import { ensureMounted, startUrl } from '../playwright/driver.js';
import { injectRuntime } from '../playwright/inject.js';
import { ensureApp } from './app.js';
import {
	baseUrl,
	type LoadedConfig,
	loadConfig,
	outDir,
	variantKey,
	variantNames,
	viewports,
} from './config.js';
import { type Argv, flagString } from './main.js';

export interface PageEntry {
	route: string;
	name: string;
	variants: Array<Record<string, string>>;
}

export function pageName(route: string): string {
	const name = route
		.replace(/^\/+/, '')
		.replace(/\.[a-z0-9]+$/i, '')
		.replace(/#/g, '-')
		.replace(/^-+|-+$/g, '');
	return name || 'home';
}

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
	return (config.pages ?? []).map((entry) => {
		const spec = typeof entry === 'string' ? { route: entry } : entry;
		return {
			route: spec.route,
			name: spec.name ?? pageName(spec.route),
			variants: combinations(spec.variants ?? configDims),
		};
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

async function shoot(
	loaded: LoadedConfig,
	page: import('@playwright/test').Page,
	route: string,
	variant: Record<string, string>,
	file: string,
): Promise<void> {
	await page.goto(startUrl(baseUrl(loaded), route));
	await ensureMounted(page);
	for (const [dim, value] of Object.entries(variant)) {
		if (dim === 'viewport') continue;
		await page.evaluate(([d, v]) => window.__journey?.applyVariant(d, v), [dim, value] as const);
	}
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: file, type: 'png' });
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
	const stopApp = await ensureApp(loaded);
	const browser = await chromium.launch();
	let failed = 0;
	const index: Array<{ name: string; route: string; keys: string[] }> = [];
	try {
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
					await shoot(loaded, page, entry.route, variant, join(dir, `${key}.png`));
					keys.push(key);
				} catch (e) {
					ok = false;
					error = e instanceof Error ? e.message : String(e);
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
	} finally {
		await browser.close();
		await stopApp();
	}
	return failed ? 1 : 0;
}
