import { expect, test } from '@playwright/test';
import type { IR, IRStep } from '../../src/core/types.js';
import { MARKER } from '../../src/runtime/actors.js';
import { createDriver, type Driver, type DriverHost } from '../../src/runtime/driver.js';
import type { Engine, Presenter } from '../../src/runtime/engine.js';
import { clearProgress, readProgress, writeProgress } from '../../src/runtime/progress.js';
import { type FakeDom, installDom, journeyEl } from './fake-dom.js';

let dom: FakeDom;
test.beforeEach(async () => {
	dom = installDom();
	await clearProgress();
});
test.afterEach(async () => {
	await clearProgress();
	dom.restore();
});

const none: Presenter = { show() {}, settle() {}, hide() {} };
const OPTS = { params: {}, variant: {}, presenter: 'none' as const };

function ir(steps: IRStep[]): IR {
	return { id: 'j', version: 1, route: '/', level: 'smoke', steps };
}

function step(id: string, extra: Partial<IRStep> = {}): IRStep {
	return { id, do: { kind: 'none' }, guide: 'next', timeout: 300, ...extra };
}

function driverWith(host: Partial<DriverHost> = {}): Driver {
	return createDriver({ presenter: () => none, ...host });
}

test('every call before load() is refused', async () => {
	const driver = driverWith();
	await expect(driver.step()).rejects.toThrow('journey driver: call load() before step()');
	await expect(driver.acted()).rejects.toThrow('journey driver: call load() before acted()');
	await expect(driver.settle()).rejects.toThrow('journey driver: call load() before settle()');
});

test('step, acted, settle walks a journey and reports the action, marker and capture', async () => {
	const save = journeyEl(dom, 'save', { tag: 'button' });
	const driver = driverWith();
	const journey = ir([
		step('open'),
		step('save', { target: 'save', do: { kind: 'click' }, capture: { name: 'saved' } }),
	]);
	expect(await driver.load(journey, OPTS)).toEqual({ resumedAt: null });

	expect(await driver.step()).toEqual({
		done: false,
		stepId: 'open',
		index: 0,
		action: null,
		marker: null,
	});
	expect(await driver.settle()).toEqual({ ok: true, capture: null, index: 0, stepId: 'open' });

	expect(await driver.step()).toEqual({
		done: false,
		stepId: 'save',
		index: 1,
		action: { kind: 'click' },
		marker: 'save',
	});
	expect(save.getAttribute(MARKER)).toBe('save');
	await driver.acted();
	expect(save.hasAttribute(MARKER)).toBe(false);
	expect(await driver.settle()).toEqual({
		ok: true,
		capture: { name: 'saved' },
		index: 1,
		stepId: 'save',
	});

	expect(await driver.step()).toEqual({
		done: true,
		result: { ok: true, completed: 2, failures: [] },
	});
	expect(await driver.step()).toMatchObject({ done: true });
});

test('out-of-order calls are refused with the call that is due', async () => {
	journeyEl(dom, 'save');
	const driver = driverWith();
	await driver.load(ir([step('save', { target: 'save', do: { kind: 'click' } })]), OPTS);
	await expect(driver.settle()).rejects.toThrow('settle() called without a pending step');
	await expect(driver.acted()).rejects.toThrow('acted() called without a pending action');
	const first = driver.step();
	await expect(driver.step()).rejects.toThrow('step() is already pending');
	await first;
	await expect(driver.step()).rejects.toThrow('call acted() and settle() before the next step()');
	await expect(driver.settle()).rejects.toThrow('call acted() before settle()');
	await driver.acted();
	await expect(driver.step()).rejects.toThrow('call settle() before the next step()');
	const settling = driver.settle();
	await expect(driver.settle()).rejects.toThrow('settle() is already pending');
	expect(await settling).toMatchObject({ ok: true, stepId: 'save' });
});

test('a failing step settles with its error and the next step() reports the failed run', async () => {
	const driver = driverWith();
	await driver.load(ir([step('check', { expect: [{ visible: 'toast' }], timeout: 100 })]), OPTS);
	await driver.step();
	expect(await driver.settle()).toEqual({
		ok: false,
		error: 'visible toast: 0 matches',
		capture: null,
		index: 0,
		stepId: 'check',
	});
	expect(await driver.step()).toEqual({
		done: true,
		result: {
			ok: false,
			completed: 0,
			failures: [{ stepId: 'check', error: 'visible toast: 0 matches' }],
		},
	});
});

test('a step on another route yields the route for the host to navigate', async () => {
	const driver = driverWith();
	await driver.load(ir([step('notes', { route: '/notes' })]), OPTS);
	expect(await driver.step()).toEqual({ done: false, stepId: 'notes', index: 0, route: '/notes' });
	const progress = await readProgress();
	expect(progress).toMatchObject({ id: 'j', index: 0, mode: 'driver', navigated: true });
});

test('load() resumes from saved driver progress for the same journey and version only', async () => {
	const journey = ir([step('a'), step('b')]);
	const base = { id: 'j', version: 1, mode: 'driver', params: {}, variant: {}, index: 1 };
	await writeProgress(base);
	const driver = driverWith();
	expect(await driver.load(journey, OPTS)).toEqual({ resumedAt: 1 });
	expect(await driver.step()).toMatchObject({ stepId: 'b', index: 1 });

	for (const stale of [{ version: 2 }, { id: 'other' }, { mode: 'guide' }]) {
		await writeProgress({ ...base, ...stale });
		expect(await driverWith().load(journey, { ...OPTS, from: 0 })).toEqual({ resumedAt: null });
	}
});

test('a resumed acted step is settled without asking for the action again', async () => {
	journeyEl(dom, 'save');
	await writeProgress({
		id: 'j',
		version: 1,
		mode: 'driver',
		params: {},
		variant: {},
		index: 0,
		acted: true,
	});
	const driver = driverWith();
	await driver.load(ir([step('save', { target: 'save', do: { kind: 'click' } })]), OPTS);
	expect(await driver.step()).toEqual({
		done: false,
		stepId: 'save',
		index: 0,
		action: null,
		marker: null,
	});
	expect(await driver.settle()).toMatchObject({ ok: true, stepId: 'save' });
});

test('a second load() stops the first run and leaves the new engine current', async () => {
	const calls: string[] = [];
	const tracked: string[] = [];
	const driver = driverWith({
		onEngine: (engine: Engine | null) => calls.push(engine ? `engine(${engine.ir.id})` : 'null'),
		track: (event) => tracked.push(event),
	});
	const journey = ir([step('s1', { route: '/#notes' })]);
	await driver.load(journey, OPTS);
	expect(await driver.step()).toMatchObject({ route: '/#notes' });
	dom.location.hash = '#notes';
	await driver.load(journey, OPTS);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(calls.at(-1)).toBe('engine(j)');
	expect(tracked).toEqual(['journey:start', 'step:start', 'journey:abort']);
});

test('load() places the overlay and hands the host presenters, probes and translations to the engine', async () => {
	const placed: string[] = [];
	const asked: string[] = [];
	let engine: Engine | null = null;
	const driver = driverWith({
		place: (placement) => placed.push(placement),
		presenter: (name) => {
			asked.push(name);
			return none;
		},
		probes: { ready: () => true },
		onEngine: (e) => {
			engine = e;
		},
	});
	await driver.load(ir([step('s', { expect: [{ probe: 'ready' }] })]), {
		...OPTS,
		presenter: 'spot',
		placement: 'banner',
	});
	expect(placed).toEqual(['banner']);
	expect(asked).toEqual(['spot']);
	await driver.step();
	expect(await driver.settle()).toMatchObject({ ok: true });
	expect((engine as Engine | null)?.deps.probes).toHaveProperty('ready');
});
