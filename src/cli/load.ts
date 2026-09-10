import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile, dropLine, type PublicDrops, publicDrops } from '../core/compile.js';
import type { CompileOptions, IR, Journey } from '../core/types.js';
import { validate } from '../core/validate.js';
import { importDefault, journeyFiles, type LoadedConfig } from './config.js';

export const HARNESS_COMPILE: CompileOptions = { public: false };
export const GUIDE_COMPILE: CompileOptions = { public: true };

export interface LoadedJourney {
	file: string;
	journey: Journey;
	ir: IR;
	dropped: PublicDrops;
}

export interface LoadedJourneys {
	journeys: LoadedJourney[];
	errors: string[];
}

export function dropReport(journeys: LoadedJourney[]): string[] {
	const lines: string[] = [];
	for (const entry of journeys) {
		const line = dropLine(entry.ir.id, entry.dropped);
		if (line) lines.push(line);
	}
	return lines;
}

export async function loadJourneys(
	loaded: LoadedConfig,
	options: CompileOptions = {},
): Promise<LoadedJourneys> {
	const journeys: LoadedJourney[] = [];
	const errors: string[] = [];
	for (const file of await journeyFiles(loaded)) {
		const label = relative(process.cwd(), file) || file;
		let journey: unknown;
		try {
			journey = importDefault<unknown>(await import(pathToFileURL(file).href));
		} catch (error) {
			errors.push(`${label}: import failed: ${error instanceof Error ? error.message : error}`);
			continue;
		}
		const result = validate(journey);
		if (!result.ok) {
			for (const e of result.errors) errors.push(`${label}: ${e.path}: ${e.message}`);
			continue;
		}
		const source = journey as Journey;
		journeys.push({
			file,
			journey: source,
			ir: compile(source, options),
			dropped: options.public === true ? publicDrops(source) : { steps: [], probes: [] },
		});
	}
	return { journeys, errors };
}

export function findJourney(loaded: LoadedJourneys, id: string): LoadedJourney {
	const found = loaded.journeys.find((j) => j.ir.id === id);
	if (!found) throw new Error(`journey: "${id}" is not among the configured journeys`);
	return found;
}
