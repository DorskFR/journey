import { type Browser, chromium, type LaunchOptions } from '@playwright/test';
import { answers, type Stop, startCommand } from '../playwright/fixtures.js';
import type { LoadedConfig } from './config.js';
import { resolveFrom } from './config.js';

export type Launcher = (options: LaunchOptions) => Promise<Browser>;

export function readyUrl(loaded: LoadedConfig): string | undefined {
	const app = loaded.config.app;
	return app?.ready ?? app?.url;
}

export async function ensureApp(loaded: LoadedConfig): Promise<Stop> {
	const app = loaded.config.app;
	const ready = readyUrl(loaded);
	if (!app?.start || !ready) return async () => {};
	if (await answers(ready)) return async () => {};
	return startCommand(app.start, {
		cwd: app.cwd ? resolveFrom(loaded, app.cwd) : loaded.dir,
		env: app.env,
		ready,
		timeout: app.timeout,
	});
}

export async function withAppBrowser<T>(
	loaded: LoadedConfig,
	options: LaunchOptions,
	run: (browser: Browser) => Promise<T>,
	launcher: Launcher = (o) => chromium.launch(o),
): Promise<T> {
	const stopApp = await ensureApp(loaded);
	try {
		const browser = await launcher(options);
		try {
			return await run(browser);
		} finally {
			await browser.close();
		}
	} finally {
		await stopApp();
	}
}
