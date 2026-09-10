import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { dropReport, GUIDE_COMPILE, HARNESS_COMPILE, loadJourneys } from './load.js';
import { type Argv, flagString } from './main.js';

export async function runCompile(argv: Argv): Promise<number> {
	const loaded = await loadConfig(flagString(argv, 'config'));
	const { journeys, errors } = await loadJourneys(
		loaded,
		argv.flags.public === true ? GUIDE_COMPILE : HARNESS_COMPILE,
	);
	if (errors.length) {
		for (const line of errors) console.error(line);
		return 1;
	}
	for (const line of dropReport(journeys)) console.error(line);
	const json = JSON.stringify(
		journeys.map((j) => j.ir),
		null,
		'\t',
	);
	const out = flagString(argv, 'o');
	if (out) {
		const file = resolve(out);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${json}\n`);
		console.log(`wrote ${journeys.length} journeys to ${file}`);
	} else {
		console.log(json);
	}
	return 0;
}
