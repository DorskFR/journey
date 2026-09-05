import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import type { IR } from '../core/types.js';
import { editorPath, runtimePath } from '../playwright/inject.js';
import { type Argv, flagString } from './main.js';

export interface ExportPayload {
	id: string;
	source: string;
	ir?: IR;
}

export interface RecordOptions {
	url: string;
	dir: string;
	har: boolean;
	headless: boolean;
}

export function recordOptions(argv: Argv): RecordOptions {
	const url = argv.positional[0];
	if (!url) throw new Error('journey record: a start url is required');
	return {
		url,
		dir: resolve(flagString(argv, 'o') ?? 'journeys'),
		har: argv.flags['no-har'] !== true && argv.flags.har !== false,
		headless: argv.flags.headless === true,
	};
}

export function forwardExportScript(): string {
	return `window.addEventListener('journey:export', (event) => {
	const detail = event.detail || {};
	window.__journeyExport({ id: detail.id, source: detail.source, ir: detail.ir });
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

export async function saveExport(
	context: BrowserContext,
	payload: ExportPayload,
	opts: RecordOptions,
): Promise<string[]> {
	const fixtures = join(opts.dir, 'fixtures');
	mkdirSync(fixtures, { recursive: true });
	const source = join(opts.dir, `${payload.id}.journey.ts`);
	writeFileSync(source, payload.source);
	const storage = join(fixtures, `${payload.id}.storage.json`);
	await context.storageState({ path: storage });
	const written = [source, storage];
	if (opts.har) written.push(join(fixtures, `${payload.id}.har`));
	return written;
}

export async function runRecord(argv: Argv): Promise<number> {
	const opts = recordOptions(argv);
	mkdirSync(join(opts.dir, 'fixtures'), { recursive: true });
	const harPath = join(opts.dir, 'fixtures', 'recording.har');
	const browser = await chromium.launch({ headless: opts.headless });
	const context = await browser.newContext({
		viewport: null,
		...(opts.har ? { recordHar: { path: harPath, mode: 'minimal' as const } } : {}),
	});
	await context.addInitScript({ path: runtimePath() });
	await context.addInitScript({ path: editorPath() });
	await context.addInitScript(forwardExportScript());

	const page = await context.newPage();
	const exported: { payload: ExportPayload | null } = { payload: null };
	const closed = new Promise<void>((done) => {
		context.on('close', () => done());
		page.on('close', () => done());
	});
	const firstExport = new Promise<ExportPayload>((done) => {
		void page.exposeFunction('__journeyExport', async (payload: ExportPayload) => {
			exported.payload = payload;
			const files = await saveExport(context, payload, opts);
			for (const file of files) console.log(file);
			done(payload);
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

	const payload = exported.payload;
	try {
		await context.close();
	} catch {}
	await browser.close();
	if (payload && opts.har) {
		renameSync(harPath, join(opts.dir, 'fixtures', `${payload.id}.har`));
	}
	return payload ? 0 : 1;
}
