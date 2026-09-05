import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import type { Config, Fixture } from '../core/types.js';

export const DEFAULT_TIMEOUT = 30000;

export interface CommandOptions {
	cwd: string;
	env?: Record<string, string>;
	ready: string;
	timeout?: number;
}

export type Stop = () => Promise<void>;

export interface FixtureContext {
	baseUrl: string;
	context: BrowserContext;
	request: APIRequestContext;
	configDir: string;
}

export interface AppliedFixture {
	params: Record<string, string>;
	stop: Stop;
}

export function resolveFrom(dir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(dir, path);
}

export async function answers(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return res.status === 200;
	} catch {
		return false;
	}
}

export async function waitForUrl(
	url: string,
	timeout: number,
	child?: ChildProcess,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (child && child.exitCode !== null) {
			throw new Error(
				`journey: command exited with code ${child.exitCode} before ${url} was ready`,
			);
		}
		if (await answers(url)) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`journey: ${url} did not answer 200 within ${timeout} ms`);
}

export function killTree(child: ChildProcess): Promise<void> {
	return new Promise((done) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			done();
			return;
		}
		child.once('exit', () => done());
		try {
			if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
			else child.kill();
		} catch {
			done();
		}
	});
}

export async function startCommand(command: string, opts: CommandOptions): Promise<Stop> {
	const child = spawn(command, {
		shell: true,
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: 'ignore',
		detached: process.platform !== 'win32',
	});
	try {
		await waitForUrl(opts.ready, opts.timeout ?? DEFAULT_TIMEOUT, child);
	} catch (error) {
		await killTree(child);
		throw error;
	}
	return () => killTree(child);
}

export function storageStatePath(
	name: string | undefined,
	config: Config,
	configDir: string,
): string | undefined {
	const file = (name ? config.fixtures?.[name]?.storageState : undefined) ?? config.storageState;
	return file === undefined ? undefined : resolveFrom(configDir, file);
}

interface StorageState {
	cookies?: Parameters<BrowserContext['addCookies']>[0];
	origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export async function applyStorageState(context: BrowserContext, file: string): Promise<void> {
	const state = JSON.parse(readFileSync(file, 'utf8')) as StorageState;
	if (state.cookies?.length) await context.addCookies(state.cookies);
	if (state.origins?.length) {
		await context.addInitScript((origins: NonNullable<StorageState['origins']>) => {
			for (const entry of origins) {
				if (entry.origin !== location.origin) continue;
				for (const item of entry.localStorage) localStorage.setItem(item.name, item.value);
			}
		}, state.origins);
	}
}

export async function applyFixture(
	name: string | undefined,
	config: Config,
	ctx: FixtureContext,
): Promise<AppliedFixture> {
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.vars ?? {})) params[`var.${key}`] = value;
	if (!name) return { params, stop: async () => {} };
	const fixture: Fixture | undefined = config.fixtures?.[name];
	if (!fixture) throw new Error(`journey: fixture "${name}" is not defined in the config`);

	let stop: Stop = async () => {};
	if (fixture.command) {
		const ready = fixture.ready ?? config.app?.url ?? ctx.baseUrl;
		stop = await startCommand(fixture.command, {
			cwd: fixture.cwd ? resolveFrom(ctx.configDir, fixture.cwd) : ctx.configDir,
			ready,
			timeout: config.app?.timeout,
		});
	}
	if (fixture.har) {
		await ctx.context.routeFromHAR(resolveFrom(ctx.configDir, fixture.har), {
			url: fixture.harUrl,
			notFound: fixture.notFound,
		});
	}
	for (const [key, value] of Object.entries(fixture.params ?? {})) params[`fixture.${key}`] = value;
	if (fixture.setup) {
		const extra = await fixture.setup({ baseUrl: ctx.baseUrl, request: ctx.request });
		for (const [key, value] of Object.entries(extra ?? {})) params[`fixture.${key}`] = value;
	}
	return { params, stop };
}
