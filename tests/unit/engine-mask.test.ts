import { expect, test } from '@playwright/test';
import type { Interaction, IR } from '../../src/core/types.js';
import { type Actor, Engine, type Presenter } from '../../src/runtime/engine.js';

const presenter: Presenter = { show() {}, settle() {}, hide() {} };

const ir: IR = {
	id: 'login',
	version: 1,
	route: '/',
	level: 'smoke',
	steps: [
		{
			id: 'key',
			do: { kind: 'fill', value: { $param: 'var.key' }, mask: true },
			guide: 'wait-for-user',
			timeout: 100,
		},
		{
			id: 'name',
			do: { kind: 'fill', value: { $param: 'name' } },
			guide: 'wait-for-user',
			timeout: 100,
		},
	],
};

test('a masked fill performs the real value but never tracks it', async () => {
	const performed: Interaction[] = [];
	const tracked: Interaction[] = [];
	const actor: Actor = {
		async navigate() {},
		async perform(_step, _el, action) {
			performed.push(action);
		},
	};
	const engine = new Engine(ir, {
		actor,
		presenter,
		params: { 'var.key': 'sk-live-4242', name: 'Ada' },
		variant: {},
		track(event, data) {
			if (event === 'step:acted') tracked.push(data.action as Interaction);
		},
	});
	const result = await engine.run();
	expect(result.ok).toBe(true);
	expect(performed).toEqual([
		{ kind: 'fill', value: 'sk-live-4242', mask: true },
		{ kind: 'fill', value: 'Ada' },
	]);
	expect(tracked).toEqual([
		{ kind: 'fill', value: '***', mask: true },
		{ kind: 'fill', value: 'Ada' },
	]);
	expect(JSON.stringify(tracked)).not.toContain('sk-live');
});
