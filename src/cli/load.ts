import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../core/compile.js';
import type { CompileOptions, IR, Journey } from '../core/types.js';
import { validate } from '../core/validate.js';
import { importDefault, journeyFiles, type LoadedConfig } from './config.js';

export interface LoadedJourney {
	file: string;
	journey: Journey;
	ir: IR;
}

export interface LoadedJourneys {
	journeys: LoadedJourney[];
	errors: string[];
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
		journeys.push({ file, journey: journey as Journey, ir: compile(journey as Journey, options) });
	}
	return { journeys, errors };
}

export function findJourney(loaded: LoadedJourneys, id: string): LoadedJourney {
	const found = loaded.journeys.find((j) => j.ir.id === id);
	if (!found) throw new Error(`journey: "${id}" is not among the configured journeys`);
	return found;
}
