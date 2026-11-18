import { expect, test } from '@playwright/test';
import { runJourney, type StepContext } from '../../src/playwright/index.js';
import { BASE, createNoteIR } from './helpers.js';

test('onStep reports every step with its say text when the card shows', async ({ page }) => {
	const seen: Array<StepContext & { called: number }> = [];
	const result = await runJourney(page, createNoteIR, {
		baseUrl: BASE,
		params: { 'var.title': 'Buy milk' },
		presenter: 'doc',
		pace: { beforeAction: 300 },
		onStep(ctx) {
			seen.push({ ...ctx, called: Date.now() });
		},
	});
	expect(result.ok, JSON.stringify(result.failures)).toBe(true);
	expect(seen.map((s) => [s.index, s.stepId, s.title])).toEqual([
		[0, 'start', 'Welcome'],
		[1, 'new', 'New note'],
		[2, 'title', 'Title'],
		[3, 'category', 'Category'],
		[4, 'save', 'Save'],
	]);
	expect(seen[3]?.body).toBe('Pick a category for the note.');
	for (const [i, s] of seen.entries()) {
		expect(s.called - s.at).toBeGreaterThanOrEqual(300);
		if (i) expect(s.at).toBeGreaterThan(seen[i - 1]?.at ?? 0);
	}
});
