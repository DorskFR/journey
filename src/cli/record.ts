import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Frame, type Page } from '@playwright/test';
import { compile } from '../core/compile.js';
import { print } from '../core/print.js';
import type { IR } from '../core/types.js';
import { SENSITIVE_NAME } from '../core/validate.js';
import { editorPath, runtimePath } from '../playwright/inject.js';
import { type Argv, flagString } from './main.js';

export interface RecordOptions {
	url: string;
	dir: string;
	secrets: string;
	har: boolean;
	storageState: boolean;
	headless: boolean;
}

export interface Recorded {
	ir: IR;
	source: string;
	masked: string[];
}

export function recordOptions(argv: Argv): RecordOptions {
	const url = argv.positional[0];
	if (!url) throw new Error('journey record: a start url is required');
	return {
		url,
		dir: resolve(flagString(argv, 'o') ?? 'journeys'),
		secrets: resolve('.journey'),
		har: argv.flags['no-har'] !== true && argv.flags.har !== false,
		storageState: argv.flags['storage-state'] === true,
		headless: argv.flags.headless === true,
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

export function acceptsFrom(page: Page, frame: Frame): boolean {
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
		mkdirSync(opts.secrets, { recursive: true });
		const ignore = join(opts.secrets, '.gitignore');
		if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
		const storage = secretFiles(recorded.ir.id, opts).storage;
		await context.storageState({ path: storage });
		written.push(storage);
	}
	if (opts.har) written.push(secretFiles(recorded.ir.id, opts).har);
	return written;
}

export function finishHar(harPath: string, recorded: Recorded, opts: RecordOptions): string {
	const target = secretFiles(recorded.ir.id, opts).har;
	const har = JSON.parse(readFileSync(harPath, 'utf8')) as Har;
	writeFileSync(harPath, JSON.stringify(scrubHar(har, recorded.masked), null, 2));
	renameSync(harPath, target);
	return target;
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
	const opts = recordOptions(argv);
	mkdirSync(join(opts.dir, 'fixtures'), { recursive: true });
	const harPath = join(opts.dir, 'fixtures', 'recording.har');
	for (const line of secretsNotice(opts)) console.error(line);
	const browser = await chromium.launch({ headless: opts.headless });
	const context = await browser.newContext({
		viewport: null,
		...(opts.har ? { recordHar: { path: harPath, mode: 'minimal' as const } } : {}),
	});
	await context.addInitScript({ path: runtimePath() });
	await context.addInitScript({ path: editorPath() });
	await context.addInitScript(forwardExportScript());

	const page = await context.newPage();
	const exported: { recorded: Recorded | null } = { recorded: null };
	const closed = new Promise<void>((done) => {
		context.on('close', () => done());
		page.on('close', () => done());
	});
	const firstExport = new Promise<Recorded>((done) => {
		void page.exposeBinding('__journeyExport', async ({ frame }, payload: unknown) => {
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
			exported.recorded = recorded;
			const files = await saveExport(context, recorded, opts);
			for (const file of files) console.log(file);
			done(recorded);
		});
	});

	await page.goto(opts.url);
	await mountEditorIn(page);
	page.on('load', () => {
		mountEditorIn(page).catch(() => {});
	});
	console.log('recording; export from the editor panel to write the journey');

	if (opts.headless) await firstExport;
	else await closed;

	const recorded = exported.recorded;
	try {
		await context.close();
	} catch {}
	await browser.close();
	if (recorded && opts.har) finishHar(harPath, recorded, opts);
	return recorded ? 0 : 1;
}
