#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { REPEAT_SEPARATOR } from './config.js';

export { REPEAT_SEPARATOR };

export interface Argv {
	command: string | undefined;
	positional: string[];
	flags: Record<string, string | boolean>;
	rest: string[];
}

export const USAGE = `Usage: journey <command> [options] [--config path]

Commands:
  compile [--public] [-o file]                       validate and print IR as JSON
  check [id...] [--strict] [--json] [--variant dim=value]
                                                     run every journey and variant
  test [playwright args...]                          run journeys through Playwright test
  record [url] [-o dir] [--no-har] [--storage-state] [--viewport name] [--headless]
                                                     record a journey in a browser
  book [id...] [--presenter p] [--placement p] [--video] [--variant dim=value]
                                                     capture screenshots, video and a report per journey and variant
  pages                                              screenshot every configured page per variant

Options:
  --config <path>   config file, default journey.config.ts
  --headed          show the browser; check, test, book and pages
  --slow-mo <ms>    pause that long before each browser operation
  --help            show this help
  --version         print the version`;

const COMMAND_HELP: Record<string, string> = {
	compile: `Usage: journey compile [--public] [-o file] [--config path]

  --public   strip qaOnly steps and qa.* probes
  -o file    write JSON to file instead of stdout`,
	check: `Usage: journey check [id...] [--strict] [--json] [--variant dim=value ...] [--headed] [--slow-mo ms] [--config path]

  id...                journeys to check, default all
  --strict             fail when any target is not a stable path, and list those targets
  --json               print one JSON report on stdout instead of a line per run
  --variant dim=value  only run variants matching, may repeat
  --headed             show the browser instead of running headless
  --slow-mo <ms>       pause that long before each browser operation

  exits 0 when every selected run passes, 1 otherwise`,
	test: `Usage: journey test [playwright args...] [--headed] [--slow-mo ms] [--config path]

  --headed        show the browser instead of running headless
  --slow-mo <ms>  pause that long before each browser operation
  every other argument (--grep, --shard, --workers, --reporter, files...) is
  forwarded to playwright test in order; everything after -- is forwarded as is`,
	record: `Usage: journey record [url] [-o dir] [--no-har] [--storage-state] [--viewport name] [--headless] [--config path]

  url              start url, default config app.url; a path is resolved against it
  -o dir           output directory, default the config's journeys dir, else journeys
  --viewport name  window size from config.variants.viewport, default its first one
  --no-har         do not record a HAR file
  --storage-state  save cookies and local storage to .journey/ (gitignored)
  --headless       run headless and exit after the first export`,
	book: `Usage: journey book [id...] [--presenter doc|spot|guide|none] [--placement anchored|banner] [--video] [--variant dim=value ...] [--headed] [--slow-mo ms] [--config path]

  id...                journeys to book, default all
  --presenter p        presenter shown in captures, default config.presenter or doc
                       doc ring, badge and caption; spot the same without the caption;
                       guide a card with Next and Exit; none nothing
  --placement p        anchored beside the target, or a banner across the bottom
  --video              record tour.webm for every journey (also when a capture has video: true)
  --variant dim=value  only run variants matching, may repeat
  --headed             show the browser instead of running headless
  --slow-mo <ms>       pause that long before each browser operation`,
	pages: `Usage: journey pages [--headed] [--slow-mo ms] [--config path]

  screenshots every config.pages route per variant to <out>/pages/<name>/<variantKey>.png

  --headed        show the browser instead of running headless
  --slow-mo <ms>  pause that long before each browser operation`,
};

const VALUE_FLAGS = new Set([
	'config',
	'o',
	'variant',
	'presenter',
	'placement',
	'slow-mo',
	'viewport',
]);
const REPEATABLE_FLAGS = new Set(['variant']);

function setFlag(out: Argv, name: string, value: string | boolean): void {
	const previous = out.flags[name];
	if (REPEATABLE_FLAGS.has(name) && typeof previous === 'string' && typeof value === 'string') {
		out.flags[name] = `${previous}${REPEAT_SEPARATOR}${value}`;
		return;
	}
	out.flags[name] = value;
}

const TEST_FLAGS = new Set(['config', 'headed', 'slow-mo', 'help']);

function flagName(arg: string): string | undefined {
	if (!arg.startsWith('--') && !(arg.length === 2 && arg.startsWith('-'))) return undefined;
	return arg.replace(/^-+/, '').split('=')[0];
}

export function parseArgv(args: string[]): Argv {
	const out: Argv = { command: undefined, positional: [], flags: {}, rest: [] };
	let i = 0;
	while (i < args.length) {
		const arg = args[i] as string;
		if (arg === '--') {
			out.rest.push(...args.slice(i + 1));
			break;
		}
		const flag = flagName(arg);
		if (out.command === 'test' && (flag === undefined || !TEST_FLAGS.has(flag))) {
			out.rest.push(arg);
		} else if (flag !== undefined) {
			const name = arg.replace(/^-+/, '');
			const eq = name.indexOf('=');
			if (eq >= 0) {
				setFlag(out, name.slice(0, eq), name.slice(eq + 1));
			} else if (VALUE_FLAGS.has(name)) {
				const value = args[i + 1];
				if (value === undefined || flagName(value) !== undefined) {
					throw new Error(`journey: ${arg} needs a value`);
				}
				setFlag(out, name, value);
				i += 1;
			} else {
				setFlag(out, name, true);
			}
		} else if (out.command === undefined) {
			out.command = arg;
		} else {
			out.positional.push(arg);
		}
		i += 1;
	}
	return out;
}

const COMMON_FLAGS = ['config', 'help', 'version'];
const BROWSER_FLAGS = ['headed', 'slow-mo'];
const COMMAND_FLAGS: Record<string, string[]> = {
	compile: ['public', 'o'],
	check: ['strict', 'json', 'variant', ...BROWSER_FLAGS],
	test: BROWSER_FLAGS,
	record: ['o', 'har', 'no-har', 'storage-state', 'viewport', 'headless'],
	book: ['presenter', 'placement', 'video', 'variant', ...BROWSER_FLAGS],
	pages: BROWSER_FLAGS,
};

export function unknownFlags(argv: Argv): string | undefined {
	const allowed = argv.command === undefined ? undefined : COMMAND_FLAGS[argv.command];
	if (!allowed) return undefined;
	const valid = [...allowed, ...COMMON_FLAGS];
	const unknown = Object.keys(argv.flags).filter((name) => !valid.includes(name));
	if (!unknown.length) return undefined;
	const dash = (name: string) => (name.length === 1 ? `-${name}` : `--${name}`);
	return `journey ${argv.command}: unknown option ${unknown.map(dash).join(', ')}, expected one of: ${valid.map(dash).join(', ')}`;
}

export function flagString(argv: Argv, name: string): string | undefined {
	const value = argv.flags[name];
	return typeof value === 'string' ? value : undefined;
}

export function flagMillis(argv: Argv, name: string): number | undefined {
	const value = argv.flags[name];
	if (value === undefined) return undefined;
	const raw = typeof value === 'string' ? value.trim() : '';
	const ms = raw === '' ? Number.NaN : Number(raw);
	if (!Number.isFinite(ms) || ms < 0) {
		throw new Error(`journey: --${name} expects milliseconds, got "${String(value)}"`);
	}
	return ms;
}

export function launchOptions(argv: Argv): { headless: boolean; slowMo?: number } {
	const slowMo = flagMillis(argv, 'slow-mo');
	return { headless: argv.flags.headed !== true, ...(slowMo === undefined ? {} : { slowMo }) };
}

const PLAYWRIGHT_HELP = `journey: this command needs @playwright/test next to @dorsk/journey.
Install it with:  npm i -D @playwright/test && npx playwright install chromium`;

async function load<T>(module: Promise<T>): Promise<T> {
	try {
		return await module;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('@playwright/test')) throw new Error(PLAYWRIGHT_HELP);
		throw error;
	}
}

async function main(args: string[]): Promise<number> {
	const argv = parseArgv(args);
	const command = argv.command;
	if (argv.flags.version) {
		console.log(VERSION);
		return 0;
	}
	if (command === undefined || (argv.flags.help && !command)) {
		console.log(USAGE);
		return argv.flags.help ? 0 : 1;
	}
	if (argv.flags.help) {
		console.log(COMMAND_HELP[command] ?? USAGE);
		return COMMAND_HELP[command] ? 0 : 1;
	}
	const unknown = unknownFlags(argv);
	if (unknown) {
		console.error(unknown);
		return 1;
	}
	switch (command) {
		case 'compile':
			return (await import('./compile.js')).runCompile(argv);
		case 'check':
			return (await load(import('./check.js'))).runCheck(argv);
		case 'test':
			return (await load(import('./test.js'))).runTest(argv);
		case 'record':
			return (await load(import('./record.js'))).runRecord(argv);
		case 'book':
			return (await load(import('./book.js'))).runBook(argv);
		case 'pages':
			return (await load(import('./pages.js'))).runPages(argv);
		default:
			console.error(`journey: unknown command "${command}"\n`);
			console.error(USAGE);
			return 1;
	}
}

function isEntryPoint(): boolean {
	const script = process.argv[1];
	if (!script) return false;
	try {
		return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		},
	);
}
