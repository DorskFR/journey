import { chromium } from '@playwright/test';
import type { IR, Target } from '../core/types.js';
import { failureMessage, runConfigured } from '../playwright/index.js';
import { ensureApp } from './app.js';
import { loadConfig, variantLabel, variantMatrix } from './config.js';
import { loadJourneys } from './load.js';
import { type Argv, flagString } from './main.js';

export type Health = 'stable' | 'fallback' | 'fragile';

export function targetHealth(target: Target): Health {
	if (typeof target === 'string') return 'stable';
	return target.css !== undefined ? 'fragile' : 'fallback';
}

export function healthCounts(ir: IR): Record<Health, number> {
	const counts: Record<Health, number> = { stable: 0, fallback: 0, fragile: 0 };
	for (const step of ir.steps) {
		if (step.target !== undefined) counts[targetHealth(step.target)] += 1;
	}
	return counts;
}

export async function runCheck(argv: Argv): Promise<number> {
	const loaded = await loadConfig(flagString(argv, 'config'));
	const { journeys, errors } = await loadJourneys(loaded);
	if (errors.length) {
		for (const line of errors) console.error(line);
		return 1;
	}
	const strict = argv.flags.strict === true;
	const stopApp = await ensureApp(loaded);
	const browser = await chromium.launch();
	let failed = 0;
	try {
		for (const entry of journeys) {
			const counts = healthCounts(entry.ir);
			for (const variant of variantMatrix(loaded.config, entry.ir)) {
				const context = await browser.newContext();
				const page = await context.newPage();
				let line: string;
				let ok: boolean;
				try {
					const result = await runConfigured(page, loaded, entry.ir, variant);
					ok = result.ok;
					line = ok ? '' : failureMessage(result).replace(/\n/g, '; ');
				} catch (error) {
					ok = false;
					line = error instanceof Error ? error.message : String(error);
				} finally {
					await context.close();
				}
				const unstable = counts.fallback + counts.fragile > 0;
				if (strict && unstable) ok = false;
				if (!ok) failed += 1;
				const health = `fallback ${counts.fallback} fragile ${counts.fragile}`;
				console.log(
					`${ok ? '✓' : '✗'} ${entry.ir.id} [${variantLabel(variant)}] ${health}${line ? ` ${line}` : ''}`,
				);
			}
		}
	} finally {
		await browser.close();
		await stopApp();
	}
	return failed ? 1 : 0;
}
