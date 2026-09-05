import { test as base, expect, type Page } from '@playwright/test';
import {
	baseUrl,
	type LoadedConfig,
	loadConfig,
	variantKey,
	variantLabel,
	variantMatrix,
	viewports,
} from '../cli/config.js';
import { findJourney, type LoadedJourney, type LoadedJourneys, loadJourneys } from '../cli/load.js';
import { compile } from '../core/compile.js';
import type { Capture, IR, Journey } from '../core/types.js';
import type { RunResult } from '../runtime/engine.js';
import { captureStep } from './capture.js';
import { type CaptureContext, type RunOptions, runJourney } from './driver.js';
import { applyFixture, applyStorageState, storageStatePath } from './fixtures.js';

export * from './capture.js';
export * from './driver.js';
export * from './fixtures.js';
export * from './inject.js';

export interface Loaded {
	config: LoadedConfig;
	journeys: LoadedJourneys;
}

export interface JourneyRunOptions {
	variant?: Record<string, string>;
	presenter?: RunOptions['presenter'];
	mask?: boolean;
	onCapture?: RunOptions['onCapture'];
}

export interface JourneyFixture {
	run(idOrIr: string | IR | Journey, opts?: JourneyRunOptions): Promise<RunResult>;
	config(): Promise<Loaded>;
}

export async function loadAll(configPath?: string): Promise<Loaded> {
	const config = await loadConfig(configPath);
	const journeys = await loadJourneys(config);
	if (journeys.errors.length) throw new Error(journeys.errors.join('\n'));
	return { config, journeys };
}

export async function runConfigured(
	page: Page,
	loaded: LoadedConfig,
	ir: IR,
	variant: Record<string, string>,
	opts: JourneyRunOptions = {},
): Promise<RunResult> {
	const url = baseUrl(loaded);
	const storage = storageStatePath(ir.fixture, loaded.config, loaded.dir);
	if (storage) await applyStorageState(page.context(), storage);
	const fixture = await applyFixture(ir.fixture, loaded.config, {
		baseUrl: url,
		context: page.context(),
		request: page.request,
		configDir: loaded.dir,
	});
	try {
		return await runJourney(page, ir, {
			baseUrl: url,
			params: fixture.params,
			variant,
			viewports: viewports(loaded.config),
			presenter: opts.presenter ?? 'none',
			mask: opts.mask,
			masks: loaded.config.mask,
			pace: opts.mask ? loaded.config.pace : undefined,
			onCapture: opts.onCapture,
		});
	} finally {
		await fixture.stop();
	}
}

function toIR(loaded: Loaded, idOrIr: string | IR | Journey): IR {
	if (typeof idOrIr === 'string') return findJourney(loaded.journeys, idOrIr).ir;
	return compile(idOrIr);
}

export function failureMessage(result: RunResult): string {
	return result.failures.map((f) => `step ${f.stepId}: ${f.error}`).join('\n');
}

export const test = base.extend<{ journey: JourneyFixture }>({
	journey: async ({ page }, use) => {
		let cached: Promise<Loaded> | null = null;
		const config = (): Promise<Loaded> => {
			cached ??= loadAll();
			return cached;
		};
		await use({
			config,
			async run(idOrIr, opts = {}) {
				const loaded = await config();
				const ir = toIR(loaded, idOrIr);
				const variant = opts.variant ?? variantMatrix(loaded.config.config, ir)[0] ?? {};
				return runConfigured(page, loaded.config, ir, variant, opts);
			},
		});
	},
});

export { expect };

function pad(n: number): string {
	return String(n + 1).padStart(2, '0');
}

export function defineJourneyTests(loaded: Loaded): void {
	for (const entry of loaded.journeys.journeys) {
		for (const variant of variantMatrix(loaded.config.config, entry.ir)) {
			registerTest(loaded, entry, variant);
		}
	}
}

function registerTest(loaded: Loaded, entry: LoadedJourney, variant: Record<string, string>): void {
	const { ir } = entry;
	base(`${ir.id} [${variantLabel(variant)}]`, async ({ page }) => {
		const key = variantKey(variant);
		let count = 0;
		const onCapture =
			ir.level === 'visual'
				? async (spec: Capture, ctx: CaptureContext): Promise<void> => {
						const png = await captureStep(page, spec, ctx);
						expect(png).toMatchSnapshot([ir.id, key, `${pad(count)}-${spec.name}.png`]);
						count += 1;
					}
				: undefined;
		const result = await runConfigured(page, loaded.config, ir, variant, { onCapture });
		expect(result.ok, failureMessage(result)).toBe(true);
	});
}

export async function journeyTests(configPath?: string): Promise<void> {
	defineJourneyTests(await loadAll(configPath));
}
