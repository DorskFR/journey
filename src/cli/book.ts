import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Browser } from '@playwright/test';
import type { Capture, IR } from '../core/types.js';
import { captureStep, startVideo } from '../playwright/capture.js';
import { type CaptureContext, errorLine } from '../playwright/driver.js';
import { failureMessage, runConfigured } from '../playwright/index.js';
import { resolveText } from '../runtime/text.js';
import { withAppBrowser } from './app.js';
import {
	type LoadedConfig,
	loadConfig,
	outDir,
	variantKey,
	variantLabel,
	variantMatrix,
	viewports,
} from './config.js';
import { HARNESS_COMPILE, type LoadedJourney, type LoadedJourneys, loadJourneys } from './load.js';
import { type Argv, flagString, launchOptions, REPEAT_SEPARATOR } from './main.js';
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

export type Presenter = 'doc' | 'spot' | 'guide' | 'none';
export type Placement = 'anchored' | 'banner';

export const DEFAULT_FORMATS: VideoFormat[] = ['webm', 'mp4'];
const PRESENTERS: Presenter[] = ['doc', 'spot', 'guide', 'none'];
const PLACEMENTS: Placement[] = ['anchored', 'banner'];

export type VariantFilter = Record<string, string[]>;

export function parseVariantFilter(value: string | undefined): VariantFilter {
	const out: VariantFilter = {};
	for (const part of (value ?? '').split(REPEAT_SEPARATOR)) {
		if (!part) continue;
		const eq = part.indexOf('=');
		if (eq <= 0) throw new Error(`journey book: --variant expects dim=value, got "${part}"`);
		const dim = part.slice(0, eq);
		const value = part.slice(eq + 1);
		const values = out[dim] ?? [];
		if (!values.includes(value)) values.push(value);
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
): void {
	const known = new Map<string, Set<string>>();
	for (const variant of matrices.flat()) {
		for (const [dim, value] of Object.entries(variant)) {
			const values = known.get(dim) ?? new Set<string>();
			known.set(dim, values.add(value));
		}
	}
	for (const [dim, values] of Object.entries(filter)) {
		const valid = known.get(dim);
		if (!valid) {
			throw new Error(
				`journey book: unknown variant dim "${dim}", expected one of: ${[...known.keys()].join(', ')}`,
			);
		}
		const unknown = values.filter((value) => !valid.has(value));
		if (unknown.length) {
			throw new Error(
				`journey book: unknown ${dim} ${unknown.map((v) => `"${v}"`).join(', ')}, expected one of: ${[...valid].join(', ')}`,
			);
		}
	}
	if (!matrices.flat().some((variant) => matchesFilter(variant, filter))) {
		const asked = Object.entries(filter)
			.map(([dim, values]) => `${dim}=${values.join('|')}`)
			.join(' ');
		throw new Error(`journey book: no variant of the selected journeys matches --variant ${asked}`);
	}
}

export function readManifest(dir: string): Manifest | null {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
		return manifest && typeof manifest.variants === 'object' ? manifest : null;
	} catch {
		return null;
	}
}

export function mergeJourneyManifest(
	journeyDir: string,
	booked: Manifest,
	matrix: Array<Record<string, string>>,
): Manifest {
	const previous = readManifest(journeyDir)?.variants ?? {};
	const variants: Manifest['variants'] = {};
	for (const variant of matrix) {
		const key = variantKey(variant);
		const kept = previous[key];
		if (booked.variants[key]) variants[key] = booked.variants[key];
		else if (kept && existsSync(join(journeyDir, key, 'manifest.json'))) variants[key] = kept;
	}
	return { ...booked, variants };
}

export function presenterOf(argv: Argv, loaded: LoadedConfig): Presenter {
	const value = flagString(argv, 'presenter') ?? loaded.config.presenter ?? 'doc';
	if (!PRESENTERS.includes(value as Presenter)) {
		throw new Error(`journey book: unknown presenter "${value}"`);
	}
	return value as Presenter;
}

export function placementOf(argv: Argv, loaded: LoadedConfig): Placement {
	const value = flagString(argv, 'placement') ?? loaded.config.placement ?? 'anchored';
	if (!PLACEMENTS.includes(value as Placement)) {
		throw new Error(`journey book: unknown placement "${value}"`);
	}
	return value as Placement;
}

export function wantsVideo(ir: IR, flag: boolean): boolean {
	return flag || ir.steps.some((step) => step.capture?.video === true);
}

export function captureFile(index: number, name: string): string {
	return `${String(index + 1).padStart(2, '0')}-${name}.png`;
}

export const BOOK_DIR = 'book';

export function bookRoot(loaded: LoadedConfig): string {
	return join(outDir(loaded), BOOK_DIR);
}

export function variantDir(out: string, id: string, key: string): string {
	const root = resolve(out);
	const dir = resolve(root, id, key);
	const rel = relative(root, dir);
	const parts = rel.split(sep);
	if (isAbsolute(rel) || parts.length !== 2 || parts.includes('..')) {
		throw new Error(`journey book: refusing to write ${dir}, outside ${root}/<id>/<variant>`);
	}
	return dir;
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
	placement: Placement;
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
	if (existsSync(dir) && !statSync(dir).isDirectory()) {
		throw new Error(`journey book: refusing to replace ${dir}, it is not a directory`);
	}
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
			placement: opts.placement,
			mask: true,
			onCapture,
		});
		ok = result.ok;
		if (!ok) error = failureMessage(result).replace(/\n/g, '; ');
	} catch (e) {
		error = errorLine(e);
		console.error(e instanceof Error ? e.message : String(e));
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

export function loadBookJourneys(loaded: LoadedConfig): Promise<LoadedJourneys> {
	return loadJourneys(loaded, HARNESS_COMPILE);
}

export async function runBook(argv: Argv): Promise<number> {
	const loaded = await loadConfig(flagString(argv, 'config'));
	const { journeys, errors } = await loadBookJourneys(loaded);
	if (errors.length) {
		for (const line of errors) console.error(line);
		return 1;
	}
	const selected = selectJourneys(journeys, argv.positional);
	const filter = parseVariantFilter(flagString(argv, 'variant'));
	if (Object.keys(filter).length) {
		checkVariantFilter(
			filter,
			selected.map((entry) => variantMatrix(loaded.config, entry.ir)),
		);
	}
	const sizes = viewports(loaded.config);
	for (const entry of selected) {
		for (const variant of variantMatrix(loaded.config, entry.ir)) {
			const name = variant.viewport ?? 'desktop';
			if (matchesFilter(variant, filter) && !sizes[name]) {
				throw new Error(
					`journey book: viewport "${name}" of ${entry.ir.id} has no size, declare it in config.variants.viewport`,
				);
			}
		}
	}
	const opts: BookOptions = {
		presenter: presenterOf(argv, loaded),
		placement: placementOf(argv, loaded),
		video: argv.flags.video === true,
		formats: loaded.config.video?.formats ?? DEFAULT_FORMATS,
	};
	const out = bookRoot(loaded);
	const launch = launchOptions(argv);
	if (!launch.headless) {
		console.error(
			'journey book: --headed writes to the same files as a headless run, but window chrome and frame timing differ; do not commit these captures',
		);
	}
	let failed = 0;
	await withAppBrowser(loaded, launch, async (browser) => {
		for (const entry of selected) {
			const ir = entry.ir;
			const journeyDir = join(out, ir.id);
			const matrix = variantMatrix(loaded.config, ir);
			const variants = matrix.filter((v) => matchesFilter(v, filter));
			const combined: Manifest = {
				id: ir.id,
				title: '',
				version: ir.version,
				variants: {},
			};
			const labels: Record<string, string> = {};
			for (const variant of matrix) labels[variantKey(variant)] = variantLabel(variant);
			for (const variant of variants) {
				const key = variantKey(variant);
				const dir = variantDir(out, ir.id, key);
				const result = await bookVariant(browser, loaded, ir, variant, dir, opts);
				const title = resolveText(ir.title, undefined, variant.locale) ?? ir.id;
				const manifest: Manifest = {
					id: ir.id,
					title,
					version: ir.version,
					variants: { [key]: result.manifest },
				};
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
				const merged = mergeJourneyManifest(journeyDir, combined, matrix);
				writeManifest(journeyDir, merged);
				writeReport(journeyDir, merged, labels);
			}
		}
	});
	return failed ? 1 : 0;
}
