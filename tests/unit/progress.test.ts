import { expect, test } from '@playwright/test';
import type { IR, IRStep } from '../../src/core/types.js';
import { createDriver } from '../../src/runtime/driver.js';
import { clearProgress, readProgress, storedParams } from '../../src/runtime/progress.js';

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
