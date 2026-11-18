import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
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
		const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
		return res.status < 500;
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
		if (await answers(url)) return;
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			const how =
				child.exitCode !== null ? `with code ${child.exitCode}` : `on ${child.signalCode}`;
			throw new Error(`journey: command exited ${how} before ${url} was ready`);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`journey: ${url} did not answer below 500 within ${timeout} ms`);
}

export const OUTPUT_LINES = 40;
const KILL_GRACE = 5000;

export class OutputTail {
	private lines: string[] = [];
	private partial = '';

	constructor(private readonly max = OUTPUT_LINES) {}

	push(chunk: Buffer | string): void {
		const parts = (this.partial + chunk.toString()).split(/\r?\n/);
		this.partial = parts.pop() ?? '';
		this.lines.push(...parts);
		if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
	}

	text(): string {
		const all = this.partial ? [...this.lines, this.partial] : this.lines;
		return all.slice(-this.max).join('\n');
	}
}

const running = new Set<ChildProcess>();

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {}
}

function killAllNow(): void {
	for (const child of running) signalTree(child, 'SIGTERM');
}

const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143 };

function onSignal(signal: NodeJS.Signals): void {
	killAllNow();
	process.exit(SIGNAL_EXIT[signal] ?? 1);
}

function track(child: ChildProcess): void {
	if (!running.size) {
		process.on('SIGINT', onSignal);
		process.on('SIGTERM', onSignal);
		process.on('exit', killAllNow);
	}
	running.add(child);
	child.once('exit', () => {
		running.delete(child);
		if (running.size) return;
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		process.off('exit', killAllNow);
	});
}

export function killTree(child: ChildProcess): Promise<void> {
	return new Promise((done) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			done();
			return;
		}
		const force = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE);
		child.once('exit', () => {
			clearTimeout(force);
			done();
		});
		signalTree(child, 'SIGTERM');
	});
}

interface Spawned {
	child: ChildProcess;
	fail(error: unknown): Promise<never>;
}

async function spawnTracked(
	command: string,
	opts: { cwd: string; env?: Record<string, string> },
): Promise<Spawned> {
	const child = spawn(command, {
		shell: true,
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	});
	track(child);
	const tail = new OutputTail();
	child.stdout?.on('data', (chunk: Buffer) => tail.push(chunk));
	child.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));
	const fail = async (error: unknown): Promise<never> => {
		await killTree(child);
		const output = tail.text();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			output
				? `${message}\nlast output of "${command}":\n${output}`
				: `${message}\n"${command}" printed nothing`,
		);
	};
	const failed = await new Promise<Error | undefined>((done) => {
		child.once('spawn', () => done(undefined));
		child.once('error', done);
	});
	if (failed) await fail(new Error(`journey: could not start "${command}": ${failed.message}`));
	return { child, fail };
}

export async function startCommand(command: string, opts: CommandOptions): Promise<Stop> {
	const { child, fail } = await spawnTracked(command, opts);
	try {
		await waitForUrl(opts.ready, opts.timeout ?? DEFAULT_TIMEOUT, child);
	} catch (error) {
		await fail(error);
	}
	for (const stream of [child.stdout, child.stderr]) (stream as Socket | null)?.unref();
	child.unref();
	return () => killTree(child);
}

const FLUSH_GRACE = 500;

export async function runCommand(
	command: string,
	opts: Omit<CommandOptions, 'ready'>,
): Promise<void> {
	const { child, fail } = await spawnTracked(command, opts);
	const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
	const closed = new Promise((done) => child.once('close', done));
	const problem = await new Promise<string | undefined>((done) => {
		const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
			clearTimeout(timer);
			if (code === 0) done(undefined);
			else done(`exited ${code !== null ? `with code ${code}` : `on ${signal}`}`);
		};
		const timer = setTimeout(() => {
			child.off('exit', exited);
			done(`did not exit within ${timeout} ms`);
		}, timeout);
		if (child.exitCode !== null || child.signalCode !== null) {
			exited(child.exitCode, child.signalCode);
		} else child.once('exit', exited);
	});
	if (problem === undefined) return;
	await Promise.race([closed, new Promise((r) => setTimeout(r, FLUSH_GRACE))]);
	await fail(new Error(`journey: "${command}" ${problem}`));
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

const appliedStates = new WeakMap<BrowserContext, Set<string>>();

export async function applyStorageState(context: BrowserContext, file: string): Promise<void> {
	const applied = appliedStates.get(context) ?? new Set<string>();
	appliedStates.set(context, applied);
	if (applied.has(file)) return;
	applied.add(file);
	const state = JSON.parse(readFileSync(file, 'utf8')) as StorageState;
	if (state.cookies?.length) await context.addCookies(state.cookies);
	if (state.origins?.length) {
		await context.addInitScript(
			({ origins, marker }: { origins: NonNullable<StorageState['origins']>; marker: string }) => {
				try {
					if (sessionStorage.getItem(marker) !== null) return;
					sessionStorage.setItem(marker, '1');
				} catch {
					return;
				}
				for (const entry of origins) {
					if (entry.origin !== location.origin) continue;
					for (const item of entry.localStorage) localStorage.setItem(item.name, item.value);
				}
			},
			{ origins: state.origins, marker: `journey:storage-state:${file}` },
		);
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
		const run = {
			cwd: fixture.cwd ? resolveFrom(ctx.configDir, fixture.cwd) : ctx.configDir,
			timeout: config.app?.timeout,
		};
		if (fixture.ready) stop = await startCommand(fixture.command, { ...run, ready: fixture.ready });
		else await runCommand(fixture.command, run);
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
