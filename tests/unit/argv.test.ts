import { expect, test } from '@playwright/test';
import { parseArgv } from '../../src/cli/main.js';
import { testArgs, testEnv } from '../../src/cli/test.js';

function forwarded(args: string[]): string[] {
	return testArgs(parseArgv(args)).slice(4);
}

test('test forwards playwright flags and their values verbatim and in order', () => {
	expect(forwarded(['test', '--grep', 'create', '--workers', '2'])).toEqual([
		'--grep',
		'create',
		'--workers',
		'2',
	]);
	expect(forwarded(['test', '-g', 'create'])).toEqual(['-g', 'create']);
	expect(forwarded(['test', '--shard=1/2', '-x'])).toEqual(['--shard=1/2', '-x']);
	expect(forwarded(['test', '--project=x', '--reporter', 'html', 'create'])).toEqual([
		'--project=x',
		'--reporter',
		'html',
		'create',
	]);
	expect(forwarded(['test', '--retries', '1', '--update-snapshots'])).toEqual([
		'--retries',
		'1',
		'--update-snapshots',
	]);
});

test('test consumes its own flags anywhere and forwards the rest', () => {
	const argv = parseArgv([
		'test',
		'--grep',
		'create',
		'--config',
		'demo/journey.config.ts',
		'--slow-mo=50',
		'--workers=2',
		'--headed',
	]);
	expect(argv.flags).toEqual({ config: 'demo/journey.config.ts', 'slow-mo': '50', headed: true });
	expect(testArgs(argv).slice(4)).toEqual(['--headed', '--grep', 'create', '--workers=2']);
	expect(testEnv(argv).JOURNEY_SLOW_MO).toBe('50');
});

test('test forwards everything after -- including journey flag names', () => {
	expect(forwarded(['test', '--workers', '1', '--', '--headed', '--config', 'x'])).toEqual([
		'--workers',
		'1',
		'--headed',
		'--config',
		'x',
	]);
});

test('other commands still parse their flags', () => {
	const argv = parseArgv(['book', 'create-note', '--variant', 'theme=dark', '-o', 'out']);
	expect(argv).toEqual({
		command: 'book',
		positional: ['create-note'],
		flags: { variant: 'theme=dark', o: 'out' },
		rest: [],
	});
	expect(parseArgv(['--config', 'c.ts', 'test', '--help']).flags).toEqual({
		config: 'c.ts',
		help: true,
	});
});
