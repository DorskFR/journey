import { expect, test } from '@playwright/test';
import type { IR, IRStep } from '../../src/core/types.js';
import { createDriver } from '../../src/runtime/driver.js';
import {
	clearProgress,
	type Progress,
	progressStore,
	readProgress,
	storedParams,
} from '../../src/runtime/progress.js';
import type { JourneyStorage } from '../../src/runtime/storage.js';

const AWAY: IRStep = {
	id: 'away',
	route: '/#notes',
	do: { kind: 'none' },
	guide: 'next',
	timeout: 300,
};

const IR_WITH_SECRETS: IR = {
	id: 'login',
	version: 1,
	route: '/',
	level: 'smoke',
	steps: [
		{
			id: 'pin',
			target: 'pin',
			do: { kind: 'fill', value: { $param: 'pin' }, mask: true },
			guide: 'next',
			timeout: 300,
		},
		AWAY,
	],
};

const PARAMS = {
	'var.title': 'Groceries',
	'var.password': 'hunter2',
	apiToken: 'tok-123',
	pin: '4242',
	note: 'kept',
	'variant.viewport': 'desktop',
};

test('progress keeps only params that are neither vars, sensitive names nor masked fills', () => {
	expect(storedParams(IR_WITH_SECRETS, PARAMS)).toEqual({
		note: 'kept',
		'variant.viewport': 'desktop',
	});
	expect(storedParams(IR_WITH_SECRETS, undefined)).toEqual({});
});

test('the driver writes progress without secret params or the IR', async () => {
	const g = globalThis as Record<string, unknown>;
	g.window = { addEventListener() {}, removeEventListener() {} };
	g.location = { pathname: '/', hash: '' };
	try {
		const none = { show() {}, settle() {}, hide() {} };
		const driver = createDriver({ presenter: () => none });
		const ir: IR = { ...IR_WITH_SECRETS, steps: [AWAY] };
		await driver.load(ir, { params: PARAMS, variant: {}, presenter: 'none' });
		expect(await driver.step()).toMatchObject({ done: false, route: '/#notes' });
		const progress = await readProgress();
		expect(progress).toMatchObject({ id: 'login', index: 0, mode: 'driver' });
		expect(progress?.params).toEqual({ pin: '4242', note: 'kept', 'variant.viewport': 'desktop' });
		const raw = JSON.stringify(progress);
		for (const secret of ['Groceries', 'hunter2', 'tok-123']) expect(raw).not.toContain(secret);
		expect(progress).not.toHaveProperty('ir');
	} finally {
		await clearProgress();
		delete g.window;
		delete g.location;
	}
});

test('progress calls reach an async adapter in the order they were made', async () => {
	const cell = new Map<string, string>();
	const delays = { set: 0, remove: 40 };
	const later = (ms: number, work: () => void) =>
		new Promise<void>((resolve) =>
			setTimeout(() => {
				work();
				resolve();
			}, ms),
		);
	const slowRemove: JourneyStorage = {
		get: async (key) => cell.get(key) ?? null,
		set: (key, value) => later(delays.set, () => cell.set(key, value)),
		remove: (key) => later(delays.remove, () => cell.delete(key)),
	};
	const store = progressStore(() => slowRemove);
	const saved: Progress = { id: 'b', version: 1, index: 0, mode: 'guide', params: {}, variant: {} };
	void store.clear();
	void store.write(saved);
	expect(await store.read()).toEqual(saved);
});
