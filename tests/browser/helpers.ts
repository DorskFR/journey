import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import createNote from '../../demo/journeys/create-note.journey.js';
import settingsTheme from '../../demo/journeys/settings-theme.journey.js';
import { compile, type Interaction, type IR, type Journey } from '../../src/index.js';
import type { LoadOptions, SettleResult, StepResult } from '../../src/runtime/index.js';

export const BASE = 'http://localhost:4177';
export const RUNTIME_PATH = fileURLToPath(new URL('../../dist/runtime.iife.js', import.meta.url));
export const RUNTIME_INIT = { path: RUNTIME_PATH };

export const createNoteIR = compile(createNote);
export const settingsThemeIR = compile(settingsTheme);

export function ir(journey: Journey): IR {
	return compile(journey);
}

export async function waitForApi(page: Page): Promise<void> {
	await page.waitForFunction(() => typeof window.__journey !== 'undefined');
}

export async function mountRuntime(page: Page, withProbes = true): Promise<void> {
	await page.evaluate((probes) => {
		const runtime = (
			window as unknown as { journeyRuntime: typeof import('../../src/runtime/index.js') }
		).journeyRuntime;
		runtime.mount(
			probes
				? {
						probes: { theme: () => document.documentElement.dataset.theme },
						variants: {
							theme: (v: string) => {
								document.documentElement.dataset.theme = v;
							},
						},
					}
				: {},
		);
	}, withProbes);
}

export function driverLoad(
	page: Page,
	journey: IR,
	opts: LoadOptions,
): Promise<{ resumedAt: number | null }> {
	return page.evaluate(
		([j, o]) => (window.__journey as NonNullable<typeof window.__journey>).driver.load(j, o),
		[journey, opts] as const,
	);
}

export function driverStep(page: Page): Promise<StepResult> {
	return page.evaluate(() =>
		(window.__journey as NonNullable<typeof window.__journey>).driver.step(),
	);
}

export function driverActed(page: Page): Promise<void> {
	return page.evaluate(() =>
		(window.__journey as NonNullable<typeof window.__journey>).driver.acted(),
	);
}

export function driverSettle(page: Page): Promise<SettleResult> {
	return page.evaluate(() =>
		(window.__journey as NonNullable<typeof window.__journey>).driver.settle(),
	);
}

export async function performAction(
	page: Page,
	marker: string,
	action: Interaction,
	timeout: number,
): Promise<void> {
	const locator = page.locator(`[data-journey-focus="${marker}"]`);
	switch (action.kind) {
		case 'click':
			await locator.click({ timeout });
			return;
		case 'dblclick':
			await locator.dblclick({ timeout });
			return;
		case 'hover':
			await locator.hover({ timeout });
			return;
		case 'fill':
			await locator.fill(action.value as string, { timeout });
			return;
		case 'select':
			await locator.selectOption(action.value as string, { timeout });
			return;
		case 'check':
			await locator.setChecked(action.checked, { timeout });
			return;
		case 'press':
			await locator.press(action.key, { timeout });
			return;
		case 'navigate':
			await page.goto(new URL(action.url, BASE).href);
			return;
		case 'none':
			return;
	}
}

export const defaultLoad: LoadOptions = {
	params: { 'var.title': 'Buy milk', 'variant.viewport': 'desktop' },
	variant: { viewport: 'desktop' },
	presenter: 'none',
};

export async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
	const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
	const chunks: Buffer[] = [];
	let offset = 8;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('ascii', offset + 4, offset + 8);
		if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(chunks));
	return [raw[1] as number, raw[2] as number, raw[3] as number];
}
