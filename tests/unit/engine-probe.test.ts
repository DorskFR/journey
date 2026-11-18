import { expect, test } from '@playwright/test';
import type { Expectation, IR } from '../../src/core/types.js';
import { type Actor, Engine, type EngineDeps, type Presenter } from '../../src/runtime/engine.js';

const presenter: Presenter = { show() {}, settle() {}, hide() {} };
const actor: Actor = { async navigate() {}, async perform() {} };

function journey(expect: Expectation[], timeout: number): IR {
	return {
		id: 'probe',
		version: 1,
		route: '/',
		level: 'smoke',
		steps: [{ id: 'p', do: { kind: 'none' }, guide: 'next', timeout, expect }],
	};
}

function run(ir: IR, deps: Partial<EngineDeps>) {
	const engine = new Engine(ir, { actor, presenter, params: {}, variant: {}, ...deps });
	const started = performance.now();
	return engine.run().then((result) => ({ result, elapsed: performance.now() - started }));
}

test('a hanging probe fails the step when the step timeout runs out', async () => {
	const { result, elapsed } = await run(journey([{ probe: 'slow' }], 300), {
		probes: { slow: () => new Promise(() => {}) },
	});
	expect(result.ok).toBe(false);
	expect(result.failures).toEqual([
		{ stepId: 'p', error: 'probe slow: no answer before the step timeout' },
	]);
	expect(elapsed).toBeLessThan(1500);
});

test('a probe that throws is retried until it passes', async () => {
	let calls = 0;
	const { result } = await run(journey([{ probe: 'flaky' }], 2000), {
		probes: {
			flaky: () => {
				calls += 1;
				if (calls < 3) throw new Error('store not ready');
				return true;
			},
		},
	});
	expect(result).toEqual({ ok: true, completed: 1, failures: [] });
	expect(calls).toBe(3);
});

test('a probe that keeps throwing fails with its last error after the timeout', async () => {
	let calls = 0;
	const { result, elapsed } = await run(journey([{ probe: 'broken' }], 300), {
		probes: {
			broken: async () => {
				calls += 1;
				throw new Error('store not ready');
			},
		},
	});
	expect(result.failures).toEqual([{ stepId: 'p', error: 'probe broken: threw store not ready' }]);
	expect(calls).toBeGreaterThan(1);
	expect(elapsed).toBeGreaterThanOrEqual(300);
});

test('a probe that answers late but within the timeout passes', async () => {
	const { result } = await run(journey([{ probe: 'late', equals: 'dark' }], 1000), {
		probes: { late: () => new Promise((resolve) => setTimeout(() => resolve('dark'), 200)) },
	});
	expect(result.ok).toBe(true);
});

test('a host presenter whose settle never resolves fails the step at its timeout', async () => {
	const { result, elapsed } = await run(journey([], 300), {
		presenter: { ...presenter, settle: () => new Promise(() => {}) },
	});
	expect(result.failures).toEqual([
		{ stepId: 'p', error: 'presenter settle: no result after 300ms' },
	]);
	expect(elapsed).toBeLessThan(1500);
});
