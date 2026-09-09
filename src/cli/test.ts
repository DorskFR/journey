import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configPath } from './config.js';
import { type Argv, flagMillis, flagString } from './main.js';

export function playwrightConfigPath(): string {
	const js = fileURLToPath(new URL('../playwright/journeys.config.js', import.meta.url));
	if (existsSync(js)) return js;
	return js.replace(/\.js$/, '.ts');
}

export function testArgs(argv: Argv): string[] {
	return [
		'playwright',
		'test',
		'-c',
		playwrightConfigPath(),
		...(argv.flags.headed === true ? ['--headed'] : []),
		...argv.positional,
		...argv.rest,
	];
}

export function testEnv(argv: Argv): Record<string, string> {
	const slowMo = flagMillis(argv, 'slow-mo');
	return {
		JOURNEY_CONFIG: configPath(flagString(argv, 'config')),
		...(slowMo === undefined ? {} : { JOURNEY_SLOW_MO: String(slowMo) }),
	};
}

export function runTest(argv: Argv): Promise<number> {
	const env = testEnv(argv);
	return new Promise((done) => {
		const child = spawn('npx', testArgs(argv), {
			stdio: 'inherit',
			shell: process.platform === 'win32',
			env: { ...process.env, ...env },
		});
		child.on('error', (error) => {
			console.error(error.message);
			done(1);
		});
		child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
	});
}
