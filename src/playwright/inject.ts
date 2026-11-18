import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';

function bundlePath(name: string): string {
	const candidates = [
		new URL(`../${name}`, import.meta.url),
		new URL(`../../dist/${name}`, import.meta.url),
	].map((url) => fileURLToPath(url));
	const found = candidates.find((file) => existsSync(file));
	if (!found) throw new Error(`journey: ${name} not found, run the build first`);
	return found;
}

export function runtimePath(): string {
	return bundlePath('runtime.iife.js');
}

export function editorPath(): string {
	return bundlePath('editor.iife.js');
}

export function runtimeSource(): string {
	return readFileSync(runtimePath(), 'utf8');
}

export function editorSource(): string {
	return readFileSync(editorPath(), 'utf8');
}

export const RUN_QUERY = 'journey';
export const RUN_FLAG_KEY = 'journey:run';

const injected = new WeakSet<BrowserContext>();

export async function injectRuntime(context: BrowserContext): Promise<void> {
	if (injected.has(context)) return;
	injected.add(context);
	await context.addInitScript(keepRunFlag, { key: RUN_FLAG_KEY, query: RUN_QUERY });
	await context.addInitScript({ path: runtimePath() });
}

function keepRunFlag({ key, query }: { key: string; query: string }): void {
	if (window !== window.top) return;
	let flag: string | null;
	try {
		flag = sessionStorage.getItem(key);
	} catch {
		return;
	}
	if (flag === null) return;
	const url = new URL(location.href);
	if (url.searchParams.has(query)) return;
	url.searchParams.set(query, flag);
	history.replaceState(history.state, '', url.href);
}

export async function injectEditor(context: BrowserContext): Promise<void> {
	await injectRuntime(context);
	await context.addInitScript({ path: editorPath() });
}
