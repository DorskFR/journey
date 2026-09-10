import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { loadBookJourneys } from '../../src/cli/book.js';
import type { LoadedConfig } from '../../src/cli/config.js';
import { dropReport, GUIDE_COMPILE, HARNESS_COMPILE, loadJourneys } from '../../src/cli/load.js';

const source = `export default {
	id: 'settings',
	steps: [
		{ id: 'open', route: '/settings.html' },
		{ id: 'check', expect: [{ probe: 'theme', equals: 'dark' }, { probe: 'qa.internal', equals: 1 }] },
		{ id: 'machines', capture: 'machines', qaOnly: true },
	],
};
`;

function fixture(): LoadedConfig {
	const dir = fileURLToPath(new URL(`../../tmp/load-${Date.now()}/`, import.meta.url));
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/settings.journey.ts`, source);
	return { config: { journeys: '*.journey.ts' }, path: `${dir}/journey.config.ts`, dir };
}

test('the book keeps a qaOnly step so its capture is still taken', async () => {
	const { journeys, errors } = await loadBookJourneys(fixture());
	expect(errors).toEqual([]);
	expect(journeys[0]?.ir.steps.map((s) => s.id)).toEqual(['open', 'check', 'machines']);
	expect(journeys[0]?.ir.steps[1]?.expect).toHaveLength(2);
	expect(dropReport(journeys)).toEqual([]);
});

test('the guide compile drops the qaOnly step and reports the drop', async () => {
	const { journeys } = await loadJourneys(fixture(), GUIDE_COMPILE);
	expect(journeys[0]?.ir.steps.map((s) => s.id)).toEqual(['open', 'check']);
	expect(journeys[0]?.ir.steps[1]?.expect).toEqual([{ probe: 'theme', equals: 'dark' }]);
	expect(dropReport(journeys)).toEqual([
		'journey settings: public compile dropped steps machines and probes check.qa.internal',
	]);
});

test('the harness compile is not public', () => {
	expect(HARNESS_COMPILE.public).toBe(false);
	expect(GUIDE_COMPILE.public).toBe(true);
});
