import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configPath } from './config.js';
import { type Argv, flagString } from './main.js';

export function playwrightConfigPath(): string {
	const js = fileURLToPath(new URL('../playwright/journeys.config.js', import.meta.url));
	if (existsSync(js)) return js;
	return js.replace(/\.js$/, '.ts');
}

export function runTest(argv: Argv): Promise<number> {
	const config = configPath(flagString(argv, 'config'));
	const args = [
		'playwright',
		'test',
		'-c',
		playwrightConfigPath(),
		...argv.positional,
		...argv.rest,
	];
	return new Promise((done) => {
		const child = spawn('npx', args, {
			stdio: 'inherit',
			shell: process.platform === 'win32',
			env: { ...process.env, JOURNEY_CONFIG: config },
		});
		child.on('error', (error) => {
			console.error(error.message);
			done(1);
		});
		child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
	});
}
