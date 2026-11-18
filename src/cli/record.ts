import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { type BrowserContext, chromium, type Frame, type Page } from '@playwright/test';
import { compile } from '../core/compile.js';
import { print } from '../core/print.js';
import type { IR } from '../core/types.js';
import { SENSITIVE_NAME } from '../core/validate.js';
import type { Viewport } from '../playwright/driver.js';
import { editorPath, runtimePath } from '../playwright/inject.js';
import { ensureApp } from './app.js';
import {
	configPath,
	journeysDir,
	type LoadedConfig,
	loadConfig,
	variantNames,
	viewports,
} from './config.js';
import { type Argv, flagString } from './main.js';

export interface RecordOptions {
	url: string;
	dir: string;
	secrets: string;
	har: boolean;
	storageState: boolean;
	headless: boolean;
	viewport?: Viewport | null;
	base?: string;
}

export interface Recorded {
	ir: IR;
	source: string;
	masked: string[];
}

export async function loadRecordConfig(argv: Argv): Promise<LoadedConfig | null> {
	const path = flagString(argv, 'config');
	if (path === undefined && !existsSync(configPath())) return null;
	return loadConfig(path);
}

function startUrl(argv: Argv, loaded: LoadedConfig | null): string {
	const given = argv.positional[0];
	const app = loaded?.config.app?.url;
	if (given && app && given.startsWith('/')) return new URL(given, app).href;
	const url = given ?? app;
	if (!url)
		throw new Error('journey record: a start url is required, or set app.url in the config');
	return url;
}

function recordViewport(argv: Argv, loaded: LoadedConfig | null): Viewport | null {
	const asked = flagString(argv, 'viewport');
	const sizes = loaded ? viewports(loaded.config) : {};
	const name = asked ?? (loaded ? variantNames(loaded.config).viewport?.[0] : undefined);
	if (name === undefined) return null;
	const size = sizes[name];
	if (!size) {
		throw new Error(
			`journey record: viewport "${name}" has no size, expected one of: ${Object.keys(sizes).join(', ') || 'none (no config)'}`,
		);
	}
	return size;
}

export function recordOptions(argv: Argv, loaded: LoadedConfig | null = null): RecordOptions {
	const out = flagString(argv, 'o');
	const base = loaded?.dir ?? resolve('.');
	return {
		url: startUrl(argv, loaded),
		dir: out !== undefined ? resolve(out) : loaded ? journeysDir(loaded) : resolve('journeys'),
		secrets: join(base, '.journey'),
		har: argv.flags['no-har'] !== true && argv.flags.har !== false,
		storageState: argv.flags['storage-state'] === true,
		headless: argv.flags.headless === true,
		viewport: recordViewport(argv, loaded),
		base,
	};
}

export function forwardExportScript(): string {
	return `window.addEventListener('journey:export', (event) => {
	const detail = event.detail || {};
	window.__journeyExport({ ir: detail.ir });
});`;
}

export async function mountEditorIn(page: Page): Promise<void> {
	await page.evaluate(() => {
		const runtime = (
			window as unknown as {
				journeyRuntime: { mount(o: object): NonNullable<Window['__journey']> };
			}
		).journeyRuntime;
		const api = runtime.mount({ editor: true, exportUrl: undefined });
		window.journeyEditor?.mountEditor(api);
	});
}

function maskedNames(ir: IR): string[] {
	const names = new Set<string>();
	for (const step of ir.steps) {
		const action = step.do;
		if (action?.kind !== 'fill' || action.mask !== true) continue;
		const value = action.value;
		if (typeof value === 'object' && value.$param.startsWith('var.')) {
			names.add(value.$param.slice('var.'.length));
		}
	}
	return Array.from(names).sort();
}

export function fromPayload(payload: unknown): Recorded {
	const ir = (payload as { ir?: unknown } | null)?.ir;
	if (typeof ir !== 'object' || ir === null) {
		throw new Error('journey record: the export carries no journey');
	}
	const compiled = compile(ir as IR);
	return { ir: compiled, source: print(compiled), masked: maskedNames(compiled) };
}

export function acceptsFrom(page: Page | null | undefined, frame: Frame): boolean {
	if (!page) return false;
	return frame === page.mainFrame();
}

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

interface HarHeader {
	name: string;
	value: string;
}
interface HarMessage {
	headers?: HarHeader[];
	cookies?: unknown[];
	postData?: { mimeType?: string; text?: string; params?: Array<{ name: string }> };
}
interface Har {
	log?: { entries?: Array<{ request?: HarMessage; response?: HarMessage }> };
}

function bodyFields(postData: NonNullable<HarMessage['postData']>): string[] {
	const names = (postData.params ?? []).map((p) => p.name);
	const text = postData.text ?? '';
	const mime = postData.mimeType ?? '';
	if (mime.includes('application/x-www-form-urlencoded')) {
		names.push(...new URLSearchParams(text).keys());
	} else if (mime.includes('json')) {
		try {
			const walk = (v: unknown): void => {
				if (Array.isArray(v)) v.forEach(walk);
				else if (typeof v === 'object' && v !== null) {
					for (const [k, item] of Object.entries(v)) {
						names.push(k);
						walk(item);
					}
				}
			};
			walk(JSON.parse(text));
		} catch {}
	} else {
		for (const m of text.matchAll(/name="([^"]*)"/g)) names.push(m[1] as string);
	}
	return names;
}

function scrubMessage(message: HarMessage | undefined, masked: Set<string>): void {
	if (!message) return;
	if (message.headers) {
		message.headers = message.headers.filter((h) => !SECRET_HEADERS.has(h.name.toLowerCase()));
	}
	if (message.cookies) message.cookies = [];
	const postData = message.postData;
	if (postData && bodyFields(postData).some((n) => masked.has(n) || SENSITIVE_NAME.test(n))) {
		delete message.postData;
	}
}

export function scrubHar(har: Har, masked: string[]): Har {
	const names = new Set(masked);
	for (const entry of har.log?.entries ?? []) {
		scrubMessage(entry.request, names);
		scrubMessage(entry.response, names);
	}
	return har;
}

export function secretFiles(id: string, opts: RecordOptions): { har: string; storage: string } {
	return {
		har: join(opts.dir, 'fixtures', `${id}.har`),
		storage: join(opts.secrets, `${id}.storage.json`),
	};
}

export function rawHarPath(opts: RecordOptions): string {
	return join(opts.secrets, 'recording.har');
}

export function ensureSecretsDir(opts: RecordOptions): void {
	mkdirSync(opts.secrets, { recursive: true });
	const ignore = join(opts.secrets, '.gitignore');
	if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
}

export async function saveExport(
	context: BrowserContext,
	recorded: Recorded,
	opts: RecordOptions,
): Promise<string[]> {
	mkdirSync(opts.dir, { recursive: true });
	const source = join(opts.dir, `${recorded.ir.id}.journey.ts`);
	writeFileSync(source, recorded.source);
	const written = [source];
	if (opts.storageState) {
		ensureSecretsDir(opts);
		const storage = secretFiles(recorded.ir.id, opts).storage;
		await context.storageState({ path: storage });
		written.push(storage);
	}
	return written;
}

export function finishHar(harPath: string, recorded: Recorded[], opts: RecordOptions): string[] {
	if (!recorded.length || !existsSync(harPath)) {
		rmSync(harPath, { force: true });
		return [];
	}
	const masked = [...new Set(recorded.flatMap((r) => r.masked))];
	const scrubbed = JSON.stringify(
		scrubHar(JSON.parse(readFileSync(harPath, 'utf8')) as Har, masked),
		null,
		2,
	);
	mkdirSync(join(opts.dir, 'fixtures'), { recursive: true });
	const written = recorded.map((r) => {
		const target = secretFiles(r.ir.id, opts).har;
		writeFileSync(target, scrubbed);
		return target;
	});
	rmSync(harPath, { force: true });
	return written;
}

function fromBase(opts: RecordOptions, path: string): string {
	const rel = relative(opts.base ?? resolve('.'), path);
	return rel.split(sep).join('/');
}

export function replaySnippet(ids: string[], opts: RecordOptions): string[] {
	if (!ids.length || (!opts.har && !opts.storageState)) return [];
	const entry = (id: string): string => {
		const files = secretFiles(id, opts);
		const parts: string[] = [];
		if (opts.har) parts.push(`har: '${fromBase(opts, files.har)}'`);
		if (opts.storageState) parts.push(`storageState: '${fromBase(opts, files.storage)}'`);
		return `\t\t'${id}': { ${parts.join(', ')} },`;
	};
	return [
		'journey record: to replay offline, add to the config:',
		'\tfixtures: {',
		...ids.map(entry),
		'\t},',
		`and to each journey: ${ids.map((id) => `fixture: '${id}'`).join(', ')}`,
	];
}

export function secretsNotice(opts: RecordOptions): string[] {
	const lines: string[] = [];
	if (opts.har) {
		lines.push(
			`journey record: the HAR in ${join(opts.dir, 'fixtures')} keeps response bodies; auth and cookie headers and request bodies with secret fields are removed, review it before committing (--no-har to skip)`,
		);
	}
	if (opts.storageState) {
		lines.push(
			`journey record: --storage-state writes session cookies and tokens to ${opts.secrets}, which is gitignored; never commit it`,
		);
	}
	return lines;
}

export async function runRecord(argv: Argv): Promise<number> {
	const loaded = await loadRecordConfig(argv);
	const opts = recordOptions(argv, loaded);
	const stopApp = loaded ? await ensureApp(loaded) : async () => {};
	try {
		return await record(opts);
	} finally {
		await stopApp();
	}
}

async function record(opts: RecordOptions): Promise<number> {
	const harPath = rawHarPath(opts);
	if (opts.har) ensureSecretsDir(opts);
	for (const line of secretsNotice(opts)) console.error(line);
	const browser = await chromium.launch({ headless: opts.headless, handleSIGINT: false });
	const context = await browser.newContext({
		viewport: opts.viewport ?? null,
		...(opts.har ? { recordHar: { path: harPath, mode: 'minimal' as const } } : {}),
	});
	await context.addInitScript({ path: runtimePath() });
	await context.addInitScript({ path: editorPath() });
	await context.addInitScript(forwardExportScript());

	const exported = new Map<string, Recorded>();
	let stop: () => void = () => {};
	const stopped = new Promise<void>((done) => {
		stop = done;
	});
	const onSigint = (): void => {
		console.error('journey record: stopping');
		stop();
	};
	process.once('SIGINT', onSigint);
	context.on('close', () => stop());
	browser.on('disconnected', () => stop());

	await context.exposeBinding('__journeyExport', async ({ frame, page }, payload: unknown) => {
		if (!acceptsFrom(page, frame)) {
			console.error('journey record: ignored an export from a child frame');
			return;
		}
		let recorded: Recorded;
		try {
			recorded = fromPayload(payload);
		} catch (e) {
			console.error((e as Error).message);
			return;
		}
		exported.set(recorded.ir.id, recorded);
		const files = await saveExport(context, recorded, opts);
		for (const file of files) console.log(file);
		if (opts.headless) stop();
	});

	const watch = (page: Page): void => {
		page.on('load', () => {
			mountEditorIn(page).catch(() => {});
		});
		page.on('close', () => {
			if (!context.pages().length) stop();
		});
	};
	const page = await context.newPage();
	try {
		await page.goto(opts.url);
		await mountEditorIn(page);
		watch(page);
		context.on('page', watch);
		console.log('recording; export from the editor panel to write the journey');
		await stopped;
	} finally {
		process.removeListener('SIGINT', onSigint);
		try {
			await context.close();
		} catch {}
		await browser.close();
		if (opts.har) {
			for (const file of finishHar(harPath, [...exported.values()], opts)) console.log(file);
		}
	}
	const ids = [...exported.keys()];
	for (const line of replaySnippet(ids, opts)) console.error(line);
	return ids.length ? 0 : 1;
}
