import { relative } from 'node:path';
import type { Config, IR, Target } from '../core/types.js';
import { errorLine } from '../playwright/driver.js';
import { runConfigured } from '../playwright/index.js';
import { describeTarget } from '../runtime/resolve.js';
import { withAppBrowser } from './app.js';
import {
	checkVariantFilter,
	loadConfig,
	matchesFilter,
	parseVariantFilter,
	selectById,
	variantLabel,
	variantMatrix,
} from './config.js';
import { HARNESS_COMPILE, type LoadedJourney, loadJourneys } from './load.js';
import { type Argv, flagString, launchOptions } from './main.js';

export type Health = 'stable' | 'fallback' | 'fragile';

export interface UnstableTarget {
	step: string;
	health: Exclude<Health, 'stable'>;
	target: string;
}

export interface CheckRun {
	variant: Record<string, string>;
	ok: boolean;
	failures: Array<{ step?: string; error: string }>;
}

export interface CheckJourney {
	id: string;
	file: string;
	ok: boolean;
	targets: Record<Health, number>;
	unstable: UnstableTarget[];
	runs: CheckRun[];
}

export interface CheckReport {
	ok: boolean;
	strict: boolean;
	errors: string[];
	journeys: CheckJourney[];
}

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

export function unstableTargets(ir: IR): UnstableTarget[] {
	const out: UnstableTarget[] = [];
	for (const step of ir.steps) {
		if (step.target === undefined) continue;
		const health = targetHealth(step.target);
		if (health !== 'stable')
			out.push({ step: step.id, health, target: describeTarget(step.target) });
	}
	return out;
}

export function journeyOk(journey: Omit<CheckJourney, 'ok'>, strict: boolean): boolean {
	return journey.runs.every((run) => run.ok) && !(strict && journey.unstable.length > 0);
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

type JourneyHealth = Pick<CheckJourney, 'id' | 'targets' | 'unstable'>;

export function runLine(journey: JourneyHealth, run: CheckRun, strict: boolean): string {
	const failsStrict = strict && journey.unstable.length > 0;
	const parts = [
		run.ok && !failsStrict ? '✓' : '✗',
		journey.id,
		`[${variantLabel(run.variant)}]`,
		`fallback ${journey.targets.fallback} fragile ${journey.targets.fragile}`,
	];
	if (failsStrict) parts.push(`strict: ${plural(journey.unstable.length, 'unstable target')}`);
	const failure = run.failures
		.map((f) => (f.step === undefined ? f.error : `step ${f.step}: ${f.error}`))
		.join('; ')
		.replace(/\n/g, '; ');
	if (failure) parts.push(failure);
	return parts.join(' ');
}

export function unstableLines(journey: JourneyHealth, strict: boolean): string[] {
	if (!strict) return [];
	return journey.unstable.map((u) => `  step ${u.step}: ${u.health} ${u.target}`);
}

export function reportOk(report: Omit<CheckReport, 'ok'>): boolean {
	return report.errors.length === 0 && report.journeys.every((j) => j.ok);
}

interface Selection {
	entries: LoadedJourney[];
	variants: Map<LoadedJourney, Array<Record<string, string>>>;
}

function select(argv: Argv, journeys: LoadedJourney[], config: Config): Selection {
	const entries = selectById(journeys, argv.positional, 'check');
	const filter = parseVariantFilter(flagString(argv, 'variant'), 'check');
	const matrices = entries.map((entry) => variantMatrix(config, entry.ir));
	checkVariantFilter(filter, matrices, 'check');
	const variants = new Map<LoadedJourney, Array<Record<string, string>>>();
	entries.forEach((entry, i) => {
		variants.set(
			entry,
			(matrices[i] ?? []).filter((v) => matchesFilter(v, filter)),
		);
	});
	return { entries: entries.filter((e) => variants.get(e)?.length), variants };
}

export async function runCheck(argv: Argv): Promise<number> {
	const json = argv.flags.json === true;
	const strict = argv.flags.strict === true;
	const emit = (report: Omit<CheckReport, 'ok'>): number => {
		const full: CheckReport = { ok: reportOk(report), ...report };
		if (json) console.log(JSON.stringify(full, null, 2));
		return full.ok ? 0 : 1;
	};
	const loaded = await loadConfig(flagString(argv, 'config'));
	const { journeys, errors } = await loadJourneys(loaded, HARNESS_COMPILE);
	const fail = (lines: string[]): number => {
		if (!json) for (const line of lines) console.error(line);
		return emit({ strict, errors: lines, journeys: [] });
	};
	if (errors.length) return fail(errors);
	let selection: Selection;
	try {
		selection = select(argv, journeys, loaded.config);
	} catch (error) {
		return fail([errorLine(error)]);
	}
	const launch = launchOptions(argv);
	const results: CheckJourney[] = [];
	await withAppBrowser(loaded, launch, async (browser) => {
		for (const entry of selection.entries) {
			const runs: CheckRun[] = [];
			const base = {
				id: entry.ir.id,
				file: relative(process.cwd(), entry.file) || entry.file,
				targets: healthCounts(entry.ir),
				unstable: unstableTargets(entry.ir),
				runs,
			};
			for (const variant of selection.variants.get(entry) ?? []) {
				const context = await browser.newContext();
				const page = await context.newPage();
				try {
					const result = await runConfigured(page, loaded, entry.ir, variant);
					runs.push({
						variant,
						ok: result.ok,
						failures: result.failures.map((f) => ({ step: f.stepId, error: f.error })),
					});
				} catch (error) {
					if (!json) console.error(error instanceof Error ? error.message : String(error));
					runs.push({ variant, ok: false, failures: [{ error: errorLine(error) }] });
				} finally {
					await context.close();
				}
				if (!json) console.log(runLine(base, runs.at(-1) as CheckRun, strict));
			}
			if (!json) for (const line of unstableLines(base, strict)) console.log(line);
			results.push({ ...base, ok: journeyOk(base, strict) });
		}
	});
	return emit({ strict, errors: [], journeys: results });
}
