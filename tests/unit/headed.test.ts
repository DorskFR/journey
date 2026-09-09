import { expect, test } from '@playwright/test';
import { launchOptions, parseArgv } from '../../src/cli/main.js';
import { testArgs, testEnv } from '../../src/cli/test.js';

test('launches headless with no flags', () => {
	expect(launchOptions(parseArgv(['book']))).toEqual({ headless: true });
});

test('--headed shows the browser', () => {
	expect(launchOptions(parseArgv(['book', '--headed']))).toEqual({ headless: false });
});

test('--slow-mo takes milliseconds in either spelling', () => {
	expect(launchOptions(parseArgv(['pages', '--slow-mo', '250']))).toEqual({
		headless: true,
		slowMo: 250,
	});
	expect(launchOptions(parseArgv(['pages', '--headed', '--slow-mo=250']))).toEqual({
		headless: false,
		slowMo: 250,
	});
});

test('--slow-mo rejects values that are not milliseconds', () => {
	for (const value of ['soon', '-1', '']) {
		expect(() => launchOptions(parseArgv(['check', `--slow-mo=${value}`]))).toThrow(/--slow-mo/);
	}
	expect(() => launchOptions(parseArgv(['check', '--slow-mo']))).toThrow(/--slow-mo/);
});

test('test forwards --headed to playwright without a -- separator', () => {
	expect(testArgs(parseArgv(['test', '--headed']))).toContain('--headed');
	expect(testArgs(parseArgv(['test']))).not.toContain('--headed');
	expect(testArgs(parseArgv(['test', '--', '--repeat-each=3']))).toContain('--repeat-each=3');
});

test('test passes --slow-mo to the playwright config through the environment', () => {
	expect(testEnv(parseArgv(['test', '--slow-mo', '120'])).JOURNEY_SLOW_MO).toBe('120');
	expect(testEnv(parseArgv(['test'])).JOURNEY_SLOW_MO).toBeUndefined();
});
