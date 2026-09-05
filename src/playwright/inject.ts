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

const injected = new WeakSet<BrowserContext>();

export async function injectRuntime(context: BrowserContext): Promise<void> {
	if (injected.has(context)) return;
	injected.add(context);
	await context.addInitScript({ path: runtimePath() });
}

export async function injectEditor(context: BrowserContext): Promise<void> {
	await injectRuntime(context);
	await context.addInitScript({ path: editorPath() });
}
