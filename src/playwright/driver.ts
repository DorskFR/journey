import type { Page } from '@playwright/test';
import type { Capture, Interaction, IR } from '../core/types.js';
import type { LoadOptions, SettleResult, StepResult } from '../runtime/driver.js';
import type { Pace, RunResult } from '../runtime/engine.js';
import { injectRuntime } from './inject.js';

export interface Viewport {
	width: number;
	height: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CaptureContext {
	index: number;
	stepId: string;
	title?: string;
	body?: string;
	rect: Rect | null;
}

export interface RunOptions {
	baseUrl: string;
	params?: Record<string, string>;
	variant?: Record<string, string>;
	viewports?: Record<string, Viewport>;
	presenter?: 'none' | 'doc' | 'guide';
	mask?: boolean;
	masks?: string[];
	pace?: Pace;
	onCapture?: (spec: Capture, ctx: CaptureContext) => Promise<void>;
	applyVariant?: boolean;
}

export const BUILTIN_VIEWPORTS: Record<string, Viewport> = {
	desktop: { width: 1280, height: 800 },
	mobile: { width: 390, height: 844 },
};

export const RUN_QUERY = 'journey';

type Api = NonNullable<Window['__journey']>;

export function startUrl(baseUrl: string, route: string): string {
	const url = new URL(route, baseUrl);
	url.searchParams.set(RUN_QUERY, 'run');
	return url.href;
}

export async function ensureMounted(page: Page): Promise<void> {
	await page.waitForLoadState('load');
	await page.evaluate(() => {
		if (window.__journey) return;
		const runtime = (window as unknown as { journeyRuntime?: { mount(o: object): unknown } })
			.journeyRuntime;
		if (!runtime) throw new Error('journey driver: runtime bundle is not injected');
		runtime.mount({});
	});
}

export async function performAction(
	page: Page,
	marker: string,
	action: Interaction,
	timeout: number,
	baseUrl: string,
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
			await page.goto(new URL(action.url, baseUrl).href);
			return;
		case 'none':
			return;
	}
}

function load(page: Page, ir: IR, opts: LoadOptions): Promise<{ resumedAt: number | null }> {
	return page.evaluate(([j, o]) => (window.__journey as Api).driver.load(j, o), [
		ir,
		opts,
	] as const);
}

function step(page: Page): Promise<StepResult> {
	return page.evaluate(() => (window.__journey as Api).driver.step());
}

function acted(page: Page): Promise<void> {
	return page.evaluate(() => (window.__journey as Api).driver.acted());
}

function settle(page: Page): Promise<SettleResult> {
	return page.evaluate(() => (window.__journey as Api).driver.settle());
}

export async function captureContext(
	page: Page,
	ir: IR,
	index: number,
	params: Record<string, string>,
	crop: Capture['crop'],
): Promise<CaptureContext> {
	const step = ir.steps[index];
	if (!step) throw new Error(`journey driver: no step at index ${index}`);
	const target = crop === 'target' ? step.target : crop === 'none' ? undefined : crop;
	return page.evaluate(
		([s, t, p]) => {
			const journey = window.__journey as Api;
			const runtime = (
				window as unknown as {
					journeyRuntime: typeof import('../runtime/index.js');
				}
			).journeyRuntime;
			let rect: Rect | null = null;
			if (t !== undefined) {
				const el = journey.overlay.target();
				if (el && t === s.target) {
					rect = { x: el.x, y: el.y, width: el.width, height: el.height };
				} else {
					const found = runtime.resolveOne(t, { ...p, ...runtime.resolveStepParams(s.params, p) });
					if ('el' in found && found.el) {
						const r = found.el.getBoundingClientRect();
						rect = { x: r.x, y: r.y, width: r.width, height: r.height };
					}
				}
			}
			return {
				index: s.index,
				stepId: s.id,
				title: s.say?.title === undefined ? undefined : journey.translate(s.say.title),
				body: s.say?.body === undefined ? undefined : journey.translate(s.say.body),
				rect,
			};
		},
		[{ ...step, index }, target, params] as const,
	);
}

export async function runJourney(page: Page, ir: IR, opts: RunOptions): Promise<RunResult> {
	await injectRuntime(page.context());
	const variant = { viewport: 'desktop', ...opts.variant };
	const params: Record<string, string> = { ...opts.params };
	for (const [dim, value] of Object.entries(variant)) params[`variant.${dim}`] = value;
	const viewport =
		opts.viewports?.[variant.viewport] ?? BUILTIN_VIEWPORTS[variant.viewport] ?? null;
	if (viewport) await page.setViewportSize(viewport);

	await page.goto(startUrl(opts.baseUrl, ir.route));
	await ensureMounted(page);
	if (opts.applyVariant !== false) {
		for (const [dim, value] of Object.entries(variant)) {
			if (dim === 'viewport') continue;
			await page.evaluate(([d, v]) => (window.__journey as Api).applyVariant(d, v), [
				dim,
				value,
			] as const);
		}
	}

	const loadOpts: LoadOptions = {
		params,
		variant,
		presenter: opts.presenter ?? 'none',
		mask: opts.mask,
		masks: opts.masks,
		pace: opts.pace,
	};
	await page.evaluate(() => sessionStorage.removeItem('journey:progress'));
	await load(page, ir, loadOpts);

	let completed = 0;
	const finish = (result: RunResult): RunResult => ({ ...result, completed });

	const reload = async (): Promise<void> => {
		await ensureMounted(page);
		await load(page, ir, loadOpts);
	};

	const afterSettle = async (settled: SettleResult): Promise<void> => {
		if (!settled.ok || !settled.capture || !opts.onCapture) return;
		const ctx = await captureContext(page, ir, settled.index, params, settled.capture.crop);
		await opts.onCapture(settled.capture, ctx);
	};

	for (;;) {
		const r = await step(page);
		if (r.done) return finish(r.result);
		if ('route' in r) {
			await page.goto(new URL(r.route, opts.baseUrl).href);
			await reload();
			continue;
		}
		const timeout = ir.steps[r.index]?.timeout ?? 10000;
		if (r.action && r.marker) {
			await performAction(page, r.marker, r.action, timeout, opts.baseUrl);
		}
		let settled: SettleResult;
		try {
			await acted(page);
			settled = await settle(page);
		} catch {
			await reload();
			const resumed = await step(page);
			if (resumed.done) return finish(resumed.result);
			if ('route' in resumed || resumed.action !== null) {
				throw new Error(`journey driver: unexpected resume at step ${resumed.stepId}`);
			}
			settled = await settle(page);
		}
		if (settled.ok) completed += 1;
		await afterSettle(settled);
	}
}
