import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import type { Capture, IR } from '../core/types.js';
import { captureStep, startVideo } from '../playwright/capture.js';
import type { CaptureContext } from '../playwright/driver.js';
import { failureMessage, runConfigured } from '../playwright/index.js';
import { resolveText } from '../runtime/text.js';
import { ensureApp } from './app.js';
import {
	type LoadedConfig,
	loadConfig,
	outDir,
	variantKey,
	variantLabel,
	variantMatrix,
	viewports,
} from './config.js';
import { type LoadedJourney, loadJourneys } from './load.js';
import { type Argv, flagString, REPEAT_SEPARATOR } from './main.js';
import { hasFfmpeg, storyboard, toGif, toMp4 } from './media.js';
import {
	type Manifest,
	type ManifestCapture,
	type ManifestVariant,
	prefixFiles,
	type VideoFormat,
	writeManifest,
	writeReport,
} from './report.js';

export type Presenter = 'doc' | 'guide' | 'none';

export const DEFAULT_FORMATS: VideoFormat[] = ['webm', 'mp4'];
const PRESENTERS: Presenter[] = ['doc', 'guide', 'none'];

export function parseVariantFilter(value: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (value ?? '').split(REPEAT_SEPARATOR)) {
		if (!part) continue;
		const eq = part.indexOf('=');
		if (eq <= 0) throw new Error(`journey book: --variant expects dim=value, got "${part}"`);
		out[part.slice(0, eq)] = part.slice(eq + 1);
	}
	return out;
}

export function matchesFilter(
	variant: Record<string, string>,
	filter: Record<string, string>,
): boolean {
	return Object.entries(filter).every(([dim, value]) => variant[dim] === value);
}

export function presenterOf(argv: Argv, loaded: LoadedConfig): Presenter {
	const value = flagString(argv, 'presenter') ?? loaded.config.presenter ?? 'doc';
	if (!PRESENTERS.includes(value as Presenter)) {
		throw new Error(`journey book: unknown presenter "${value}"`);
	}
	return value as Presenter;
}

export function wantsVideo(ir: IR, flag: boolean): boolean {
	return flag || ir.steps.some((step) => step.capture?.video === true);
}

export function captureFile(index: number, name: string): string {
	return `${String(index + 1).padStart(2, '0')}-${name}.png`;
}

export function selectJourneys(journeys: LoadedJourney[], ids: string[]): LoadedJourney[] {
	if (!ids.length) return journeys;
	return ids.map((id) => {
		const found = journeys.find((entry) => entry.ir.id === id);
		if (!found) throw new Error(`journey book: "${id}" is not among the configured journeys`);
		return found;
	});
}

export function convertVideo(
	dir: string,
	formats: VideoFormat[],
): Partial<Record<VideoFormat, string>> {
	const webm = join(dir, 'tour.webm');
	const video: Partial<Record<VideoFormat, string>> = {};
	if (!existsSync(webm) || statSync(webm).size === 0) return video;
	if (!hasFfmpeg()) {
		video.webm = 'tour.webm';
		return video;
	}
	if (formats.includes('mp4')) {
		toMp4(webm, join(dir, 'tour.mp4'));
		video.mp4 = 'tour.mp4';
	}
	if (formats.includes('gif')) {
		toGif(webm, join(dir, 'tour.gif'));
		video.gif = 'tour.gif';
	}
	if (formats.includes('webm')) video.webm = 'tour.webm';
	else rmSync(webm, { force: true });
	return video;
}

interface BookOptions {
	presenter: Presenter;
	video: boolean;
	formats: VideoFormat[];
}

async function bookVariant(
	browser: Browser,
	loaded: LoadedConfig,
	ir: IR,
	variant: Record<string, string>,
	dir: string,
	opts: BookOptions,
): Promise<{ ok: boolean; error?: string; manifest: ManifestVariant }> {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const viewport = viewports(loaded.config)[variant.viewport ?? 'desktop'];
	const context = await browser.newContext(viewport ? { viewport } : {});
	const page = await context.newPage();
	const captures: ManifestCapture[] = [];
	const files: string[] = [];
	let stopVideo: (() => Promise<void>) | undefined;
	let ok = false;
	let error: string | undefined;
	try {
		if (wantsVideo(ir, opts.video)) {
			const size = loaded.config.video?.size ?? viewport;
			stopVideo = await startVideo(page, join(dir, 'tour.webm'), size);
		}
		const onCapture = async (spec: Capture, ctx: CaptureContext): Promise<void> => {
			const file = captureFile(captures.length, spec.name);
			writeFileSync(join(dir, file), await captureStep(page, spec, ctx));
			files.push(join(dir, file));
			captures.push({ index: ctx.index, name: spec.name, file, title: ctx.title, body: ctx.body });
		};
		const result = await runConfigured(page, loaded, ir, variant, {
			presenter: opts.presenter,
			mask: true,
			onCapture,
		});
		ok = result.ok;
		if (!ok) error = failureMessage(result).replace(/\n/g, '; ');
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		if (stopVideo) await stopVideo();
		await context.close();
	}
	const manifest: ManifestVariant = { captures };
	try {
		const video = convertVideo(dir, opts.formats);
		if (Object.keys(video).length) manifest.video = video;
		if (files.length) {
			await storyboard(files, join(dir, 'storyboard.png'), browser);
			manifest.storyboard = 'storyboard.png';
		}
	} catch (e) {
		ok = false;
		error = e instanceof Error ? e.message : String(e);
	}
	return { ok, error, manifest };
}

export async function runBook(argv: Argv): Promise<number> {
	const loaded = await loadConfig(flagString(argv, 'config'));
	const { journeys, errors } = await loadJourneys(loaded, { public: true });
	if (errors.length) {
		for (const line of errors) console.error(line);
		return 1;
	}
	const selected = selectJourneys(journeys, argv.positional);
	const filter = parseVariantFilter(flagString(argv, 'variant'));
	const opts: BookOptions = {
		presenter: presenterOf(argv, loaded),
		video: argv.flags.video === true,
		formats: loaded.config.video?.formats ?? DEFAULT_FORMATS,
	};
	const out = outDir(loaded);
	const stopApp = await ensureApp(loaded);
	const browser = await chromium.launch();
	let failed = 0;
	try {
		for (const entry of selected) {
			const ir = entry.ir;
			const journeyDir = join(out, ir.id);
			const variants = variantMatrix(loaded.config, ir).filter((v) => matchesFilter(v, filter));
			const combined: Manifest = {
				id: ir.id,
				title: '',
				version: ir.version,
				variants: {},
			};
			const labels: Record<string, string> = {};
			for (const variant of variants) {
				const key = variantKey(variant);
				const dir = join(journeyDir, key);
				const result = await bookVariant(browser, loaded, ir, variant, dir, opts);
				const title = resolveText(ir.title, undefined, variant.locale) ?? ir.id;
				const manifest: Manifest = {
					id: ir.id,
					title,
					version: ir.version,
					variants: { [key]: result.manifest },
				};
				labels[key] = variantLabel(variant);
				writeManifest(dir, manifest);
				writeReport(dir, manifest, labels);
				combined.title ||= title;
				combined.variants[key] = prefixFiles(result.manifest, key);
				if (!result.ok) failed += 1;
				console.log(
					`${result.ok ? '✓' : '✗'} ${ir.id} [${variantLabel(variant)}] ${dir}${result.error ? ` ${result.error}` : ''}`,
				);
			}
			if (variants.length) {
				writeManifest(journeyDir, combined);
				writeReport(journeyDir, combined, labels);
			}
		}
	} finally {
		await browser.close();
		await stopApp();
	}
	return failed ? 1 : 0;
}
