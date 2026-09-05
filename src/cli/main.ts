#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Argv {
	command: string | undefined;
	positional: string[];
	flags: Record<string, string | boolean>;
	rest: string[];
}

export const USAGE = `Usage: journey <command> [options] [--config path]

Commands:
  compile [--public] [-o file]                       validate and print IR as JSON
  check [--strict]                                   run every journey and variant headlessly
  test [playwright args...]                          run journeys through Playwright test
  record <url> [-o dir] [--no-har] [--headless]      record a journey in a browser
  book                                               not implemented yet
  pages                                              not implemented yet

Options:
  --config <path>   config file, default journey.config.ts
  --help            show this help`;

const COMMAND_HELP: Record<string, string> = {
	compile: `Usage: journey compile [--public] [-o file] [--config path]

  --public   strip qaOnly steps and qa.* probes
  -o file    write JSON to file instead of stdout`,
	check: `Usage: journey check [--strict] [--config path]

  --strict   fail when any target is not a stable path`,
	test: `Usage: journey test [playwright args...] [--config path]

  extra arguments are forwarded to playwright test`,
	record: `Usage: journey record <url> [-o dir] [--no-har] [--headless] [--config path]

  -o dir       output directory, default journeys
  --no-har     do not record a HAR file
  --headless   run headless and exit after the first export`,
};

const VALUE_FLAGS = new Set(['config', 'o', 'variant', 'presenter']);

export function parseArgv(args: string[]): Argv {
	const out: Argv = { command: undefined, positional: [], flags: {}, rest: [] };
	let i = 0;
	while (i < args.length) {
		const arg = args[i] as string;
		if (arg === '--') {
			out.rest.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith('--') || (arg.length === 2 && arg.startsWith('-'))) {
			const name = arg.replace(/^-+/, '');
			const eq = name.indexOf('=');
			if (eq >= 0) {
				out.flags[name.slice(0, eq)] = name.slice(eq + 1);
			} else if (VALUE_FLAGS.has(name) && i + 1 < args.length) {
				out.flags[name] = args[i + 1] as string;
				i += 1;
			} else {
				out.flags[name] = true;
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

export function flagString(argv: Argv, name: string): string | undefined {
	const value = argv.flags[name];
	return typeof value === 'string' ? value : undefined;
}

async function main(args: string[]): Promise<number> {
	const argv = parseArgv(args);
	const command = argv.command;
	if (command === undefined || (argv.flags.help && !command)) {
		console.log(USAGE);
		return argv.flags.help ? 0 : 1;
	}
	if (argv.flags.help) {
		console.log(COMMAND_HELP[command] ?? USAGE);
		return COMMAND_HELP[command] ? 0 : 1;
	}
	switch (command) {
		case 'compile':
			return (await import('./compile.js')).runCompile(argv);
		case 'check':
			return (await import('./check.js')).runCheck(argv);
		case 'test':
			return (await import('./test.js')).runTest(argv);
		case 'record':
			return (await import('./record.js')).runRecord(argv);
		case 'book':
		case 'pages':
			console.error(`journey ${command}: not implemented yet`);
			return 1;
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
