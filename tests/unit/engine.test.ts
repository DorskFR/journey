import { expect, test } from '@playwright/test';
import type { Expectation, Interaction, IR, IRStep } from '../../src/core/types.js';
import {
	type Actor,
	type ActorCtx,
	Engine,
	type EngineDeps,
	matchesUrl,
	type Presenter,
	type ShowCtx,
} from '../../src/runtime/engine.js';
import { type FakeDom, type FakeElement, installDom, journeyEl } from './fake-dom.js';

let dom: FakeDom;
test.beforeEach(() => {
	dom = installDom();
});
test.afterEach(() => dom.restore());

function ir(steps: IRStep[], extra: Partial<IR> = {}): IR {
	return { id: 'j', version: 1, route: '/', level: 'smoke', steps, ...extra };
}

function step(id: string, extra: Partial<IRStep> = {}): IRStep {
	return { id, do: { kind: 'none' }, guide: 'next', timeout: 200, ...extra };
}

interface Log {
	lines: string[];
	shows: Array<{ step: string; el: Element | null; ctx: ShowCtx }>;
}

function recorder(log: Log, tag = 'p'): Presenter {
	return {
		show(s, el, ctx) {
			log.lines.push(`${tag}.show ${s.id}`);
			log.shows.push({ step: s.id, el, ctx });
		},
		settle(s) {
			log.lines.push(`${tag}.settle ${s.id}`);
		},
		hide() {
			log.lines.push(`${tag}.hide`);
		},
	};
}

function actorLogging(log: Log, extra: Partial<Actor> = {}): Actor {
	return {
		async navigate(route) {
			log.lines.push(`navigate ${route}`);
		},
		async perform(s, el, action) {
			log.lines.push(
				`perform ${s.id} ${action.kind}${el ? ` on ${el.getAttribute('data-journey')}` : ''}`,
			);
		},
		...extra,
	};
}

function newLog(): Log {
	return { lines: [], shows: [] };
}

function engineFor(journey: IR, log: Log, deps: Partial<EngineDeps> = {}): Engine {
	const engine = new Engine(journey, {
		actor: actorLogging(log),
		presenter: recorder(log),
		params: {},
		variant: {},
		...deps,
	});
	for (const event of [
		'journey:start',
		'step:start',
		'step:resolved',
		'step:acted',
		'step:pass',
		'step:fail',
		'step:skip',
		'journey:done',
		'journey:abort',
	] as const) {
		engine.on(event, (data) => {
			const id = data.stepId === undefined ? '' : ` ${String(data.stepId)}`;
			log.lines.push(`${event}${id}`);
		});
	}
	return engine;
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; elapsed: number }> {
	const started = performance.now();
	const value = await work;
	return { value, elapsed: performance.now() - started };
}

test('steps run in order: resolve, show, act, settle, pass, with progress saved around each', async () => {
	journeyEl(dom, 'save', { tag: 'button' });
	const log = newLog();
	const saves: string[] = [];
	const engine = engineFor(
		ir([step('open'), step('save', { target: 'save', do: { kind: 'click' } })]),
		log,
		{
			progress: {
				save: (index, acted, navigated) =>
					saves.push(`${index}:${acted}${navigated ? ':nav' : ''}`),
				clear: () => saves.push('clear'),
			},
		},
	);
	const result = await engine.run();
	expect(result).toEqual({ ok: true, completed: 2, failures: [] });
	expect(log.lines).toEqual([
		'journey:start',
		'step:start open',
		'step:resolved open',
		'p.show open',
		'perform open none',
		'step:acted open',
		'p.settle open',
		'step:pass open',
		'step:start save',
		'step:resolved save',
		'p.show save',
		'perform save click on save',
		'step:acted save',
		'p.settle save',
		'step:pass save',
		'journey:done',
		'p.hide',
	]);
	expect(saves).toEqual(['0:false', '0:true', '1:false', '1:false', '1:true', '2:false', 'clear']);
	expect(engine.index).toBe(1);
});

test('the show context carries the index, total, resolved text and a Next only for next steps', async () => {
	const log = newLog();
	const translate = (id: string, locale: string) => (id === 'hi' ? `hi in ${locale}` : undefined);
	const engine = engineFor(
		ir([
			step('a', { say: { title: { $msg: 'hi' }, body: { en: 'Hello', fr: 'Bonjour' } } }),
			step('b', { guide: 'wait-for-user' }),
		]),
		log,
		{ translate, variant: { locale: 'fr' } },
	);
	await engine.run();
	const [a, b] = log.shows;
	expect(a?.ctx).toMatchObject({ index: 0, total: 2, title: 'hi in fr', body: 'Bonjour' });
	expect(typeof a?.ctx.next).toBe('function');
	expect(b?.ctx.next).toBeNull();
});

test('a target that never appears fails the step after its timeout', async () => {
	const log = newLog();
	const engine = engineFor(ir([step('save', { target: 'save', do: { kind: 'click' } })]), log);
	const { value, elapsed } = await timed(engine.run());
	expect(value).toEqual({
		ok: false,
		completed: 0,
		failures: [{ stepId: 'save', error: 'target save: 0 matches after 200ms' }],
	});
	expect(elapsed).toBeGreaterThanOrEqual(190);
	expect(log.lines).not.toContain('perform save click on save');
	expect(log.lines.slice(-3)).toEqual(['step:fail save', 'journey:done', 'p.hide']);
});

test('a target that appears while the step waits is acted on', async () => {
	const log = newLog();
	setTimeout(() => journeyEl(dom, 'late'), 120);
	const engine = engineFor(
		ir([step('s', { target: 'late', do: { kind: 'click' }, timeout: 1000 })]),
		log,
	);
	expect(await engine.run()).toMatchObject({ ok: true, completed: 1 });
	expect(log.lines).toContain('perform s click on late');
});

test('an ambiguous target fails at once and suggests an index', async () => {
	journeyEl(dom, 'row');
	journeyEl(dom, 'row');
	const { value, elapsed } = await timed(
		engineFor(ir([step('pick', { target: 'row', timeout: 2000 })]), newLog()).run(),
	);
	expect(value.failures).toEqual([
		{
			stepId: 'pick',
			error: 'target row: ambiguous, 2 matches (add a key or an index, e.g. "row[#0]")',
		},
	]);
	expect(elapsed).toBeLessThan(1000);
});

test('hidden elements do not count as matches', async () => {
	journeyEl(dom, 'row').hidden = true;
	const visible = journeyEl(dom, 'row');
	const log = newLog();
	await engineFor(ir([step('pick', { target: 'row', do: { kind: 'click' } })]), log).run();
	expect(log.shows.at(-1)?.el).toBe(visible);
});

test('`when` skips steps whose variant does not match, before any action', async () => {
	const log = newLog();
	const engine = engineFor(
		ir([
			step('phone', { when: { viewport: 'mobile' } }),
			step('desk', { when: { viewport: 'desktop' } }),
		]),
		log,
		{ variant: { viewport: 'desktop' } },
	);
	expect(await engine.run()).toEqual({ ok: true, completed: 1, failures: [] });
	expect(log.lines.slice(0, 3)).toEqual(['journey:start', 'step:skip phone', 'step:start desk']);
	expect(log.lines).not.toContain('perform phone none');
});

test('an optional step whose target is missing is skipped and the run goes on', async () => {
	const log = newLog();
	const skips: unknown[] = [];
	const engine = engineFor(
		ir([
			step('cookies', { target: 'cookie-banner', do: { kind: 'click' }, optional: true }),
			step('after'),
		]),
		log,
	);
	engine.on('step:skip', (data) => skips.push(data.reason));
	expect(await engine.run()).toEqual({ ok: true, completed: 1, failures: [] });
	expect(skips).toEqual(['target cookie-banner not found']);
	expect(log.lines).toContain('perform after none');
});

test('an unresolved param fails the step that reads it', async () => {
	const result = await engineFor(
		ir([step('title', { do: { kind: 'fill', value: { $param: 'var.title' } } })]),
		newLog(),
	).run();
	expect(result.failures).toEqual([{ stepId: 'title', error: 'Unresolved param "var.title"' }]);
});

test('step params resolve from run params and key the target', async () => {
	journeyEl(dom, 'row', { key: 'a' });
	const b = journeyEl(dom, 'row', { key: 'b' });
	const log = newLog();
	await engineFor(
		ir([step('pick', { target: 'row[{id}]', params: { id: { $param: 'which' } } })]),
		log,
		{ params: { which: 'b' } },
	).run();
	expect(log.shows.at(-1)?.el).toBe(b);
});

function field(name: string, value: string): FakeElement {
	const el = journeyEl(dom, name, { tag: 'input' });
	el.value = value;
	return el;
}

function els(...names: string[]): () => void {
	return () => {
		for (const name of names) journeyEl(dom, name);
	};
}

function nothing(): void {}

function checkedBox(): void {
	journeyEl(dom, 'c', { tag: 'input' }).checked = true;
}

function disabledButton(): void {
	journeyEl(dom, 'b', { tag: 'button' }).disabled = true;
}

const PASSING: Array<[string, () => void, Expectation]> = [
	['visible', els('v'), { visible: 'v' }],
	['hidden', nothing, { hidden: 'nothing-here' }],
	['text', () => journeyEl(dom, 't', { text: '  Saved 3 items ' }), { text: ['t', 'Saved 3'] }],
	['value', () => field('f', 'Ada'), { value: ['f', 'Ada'] }],
	['checked', checkedBox, { checked: ['c', true] }],
	['enabled', els('b'), { enabled: 'b' }],
	['disabled', disabledButton, { disabled: 'b' }],
	['url', nothing, { url: '/' }],
	['count', els('i', 'i'), { count: ['i', { min: 1, max: 2 }] }],
	['probe', nothing, { probe: 'theme', equals: 'dark' }],
];

for (const [kind, page, expectation] of PASSING) {
	test(`a met ${kind} expectation passes the step`, async () => {
		page();
		const result = await engineFor(ir([step('s', { expect: [expectation] })]), newLog(), {
			probes: { theme: () => 'dark' },
		}).run();
		expect(result).toEqual({ ok: true, completed: 1, failures: [] });
	});
}

const FAILING: Array<[string, () => void, Expectation, string]> = [
	['visible', nothing, { visible: 'v' }, 'visible v: 0 matches'],
	['hidden', els('h'), { hidden: 'h' }, 'hidden h: 1 visible'],
	[
		'text',
		() => journeyEl(dom, 't', { text: 'Draft' }),
		{ text: ['t', 'Saved'] },
		'text t "Saved": "Draft"',
	],
	['text without a match', nothing, { text: ['t', 'Saved'] }, 'text t "Saved": 0 matches'],
	['value', () => field('f', 'Bob'), { value: ['f', 'Ada'] }, 'value f "Ada": "Bob"'],
	['value without a match', nothing, { value: ['f', 'Ada'] }, 'value f: 0 matches'],
	[
		'value on an ambiguous target',
		() => [field('f', 'Ada'), field('f', 'Ada')],
		{ value: ['f', 'Ada'] },
		'value f: 2 matches',
	],
	[
		'checked',
		() => journeyEl(dom, 'c', { tag: 'input' }),
		{ checked: ['c', true] },
		'checked c true: false',
	],
	['enabled', disabledButton, { enabled: 'b' }, 'enabled b: disabled'],
	['disabled', els('b'), { disabled: 'b' }, 'disabled b: enabled'],
	['url', nothing, { url: '/settings/*' }, 'url /settings/*: /'],
	['count', els('i'), { count: ['i', { equals: 2 }] }, 'count i: 1'],
	['event', nothing, { event: 'saved' }, 'event saved: not fired'],
	['probe', nothing, { probe: 'theme', equals: 'light' }, 'probe theme: "dark"'],
	['unknown probe', nothing, { probe: 'nope' }, 'probe nope: not registered'],
];

for (const [kind, page, expectation, error] of FAILING) {
	test(`an unmet ${kind} expectation fails the step with what it saw`, async () => {
		page();
		const result = await engineFor(
			ir([step('s', { expect: [expectation], timeout: 150 })]),
			newLog(),
			{
				probes: { theme: () => 'dark' },
			},
		).run();
		expect(result.failures).toEqual([{ stepId: 's', error }]);
	});
}

test('an event expectation passes when the action fires the event on window', async () => {
	const log = newLog();
	const result = await engineFor(ir([step('s', { expect: [{ event: 'saved' }] })]), log, {
		actor: actorLogging(log, {
			async perform() {
				window.dispatchEvent(new Event('saved'));
			},
		}),
	}).run();
	expect(result.ok).toBe(true);
});

test('an event fired during an earlier step does not satisfy a later one', async () => {
	const log = newLog();
	const result = await engineFor(
		ir([step('first'), step('second', { expect: [{ event: 'saved' }], timeout: 150 })]),
		log,
		{
			actor: actorLogging(log, {
				async perform(s) {
					if (s.id === 'first') window.dispatchEvent(new Event('saved'));
				},
			}),
		},
	).run();
	expect(result.failures).toEqual([{ stepId: 'second', error: 'event saved: not fired' }]);
});

test('expectations are polled until they hold within the step timeout', async () => {
	const status = journeyEl(dom, 'status', { text: 'Saving' });
	setTimeout(() => {
		status.ownText = 'Saved';
	}, 150);
	const result = await engineFor(
		ir([step('s', { expect: [{ text: ['status', 'Saved'] }], timeout: 1000 })]),
		newLog(),
	).run();
	expect(result.ok).toBe(true);
});

test('url patterns match one segment with * and any depth with **', () => {
	dom.location.pathname = '/projects/42/settings';
	expect(matchesUrl('/projects/*/settings')).toBe(true);
	expect(matchesUrl('/projects/*')).toBe(false);
	expect(matchesUrl('/projects/**')).toBe(true);
	expect(matchesUrl('/projects/42/settings')).toBe(true);
	dom.location.hash = '#tab';
	expect(matchesUrl('/projects/42/settings#tab')).toBe(true);
	expect(matchesUrl('/projects/42/settings')).toBe(true);
});

test('a step on another route navigates there through the actor first', async () => {
	const log = newLog();
	const engine = engineFor(ir([step('s', { route: '/settings' })]), log, {
		actor: actorLogging(log, {
			async navigate(route) {
				log.lines.push(`navigate ${route}`);
				dom.location.pathname = route;
			},
		}),
	});
	expect(await engine.run()).toMatchObject({ ok: true });
	expect(log.lines.indexOf('navigate /settings')).toBeLessThan(log.lines.indexOf('perform s none'));
});

test('a navigation that never arrives fails with the url the page is on', async () => {
	const result = await engineFor(ir([step('s', { route: '/settings' })]), newLog()).run();
	expect(result.failures).toEqual([{ stepId: 's', error: 'route /settings: /' }]);
});

test('after an action the engine waits for the app to reach the next route instead of navigating', async () => {
	const log = newLog();
	const engine = engineFor(
		ir([step('go', { do: { kind: 'click' }, target: 'link' }), step('there', { route: '/b' })]),
		log,
		{
			actor: actorLogging(log, {
				async perform(s) {
					log.lines.push(`perform ${s.id}`);
					if (s.id === 'go') setTimeout(() => (dom.location.pathname = '/b'), 80);
				},
			}),
		},
	);
	journeyEl(dom, 'link');
	expect(await engine.run()).toMatchObject({ ok: true, completed: 2 });
	expect(log.lines.filter((l) => l.startsWith('navigate'))).toEqual([]);
});

test('a resumed run re-shows the acted step without performing it again', async () => {
	journeyEl(dom, 'save');
	const log = newLog();
	const resumed: string[] = [];
	const engine = engineFor(
		ir([step('first'), step('save', { target: 'save', do: { kind: 'click' } }), step('after')]),
		log,
		{
			actor: actorLogging(log, {
				async resume(s) {
					resumed.push(s.id);
				},
			}),
		},
	);
	expect(await engine.run(1, { acted: true })).toEqual({ ok: true, completed: 2, failures: [] });
	expect(resumed).toEqual(['save']);
	expect(log.lines.filter((l) => l.startsWith('perform'))).toEqual(['perform after none']);
	expect(log.shows[0]?.ctx.next).toBeNull();
});

test('stop() aborts the step in flight and reports the exit', async () => {
	const log = newLog();
	const aborts: unknown[] = [];
	const saves: string[] = [];
	const engine = engineFor(ir([step('wait', { guide: 'wait-for-user', timeout: 60000 })]), log, {
		actor: actorLogging(log, {
			perform: (_s, _el, _a, ctx: ActorCtx) =>
				new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve())),
		}),
		progress: { save: () => {}, clear: () => saves.push('clear') },
	});
	engine.on('journey:abort', (data) => aborts.push(data));
	const run = engine.run();
	await new Promise((resolve) => setTimeout(resolve, 50));
	engine.stop();
	expect(await run).toEqual({ ok: false, completed: 0, failures: [], aborted: true });
	expect(aborts).toEqual([{ journey: 'j', index: 0, exit: true }]);
	expect(saves).toEqual(['clear']);
	expect(log.lines.at(-1)).toBe('p.hide');
	expect(engine.aborted).toBe(true);
});

test('stop() during a step timeout aborts at once instead of waiting it out', async () => {
	const engine = engineFor(ir([step('s', { target: 'never', timeout: 60000 })]), newLog());
	const run = timed(engine.run());
	setTimeout(() => engine.stop(), 50);
	const { value, elapsed } = await run;
	expect(value.aborted).toBe(true);
	expect(elapsed).toBeLessThan(1000);
});

test('a stopped engine runs again from scratch, and a second concurrent run is refused', async () => {
	const engine = engineFor(ir([step('s', { target: 'never', timeout: 60000 })]), newLog());
	engine.stop();
	const first = engine.run();
	await expect(engine.run()).rejects.toThrow('Engine is already running');
	engine.stop();
	expect((await first).aborted).toBe(true);
	journeyEl(dom, 'never');
	expect(await engine.run()).toMatchObject({ ok: true, completed: 1 });
});

test('a restarted run clears the old progress before the new run saves its own', async () => {
	const lines: string[] = [];
	const blocking: Actor = {
		async navigate() {},
		perform: (_s, _el, _a, ctx) =>
			new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve())),
	};
	const make = (tag: string, id: string) =>
		new Engine(ir([step(id, { guide: 'wait-for-user', timeout: 60000 })]), {
			actor: blocking,
			presenter: recorder({ lines, shows: [] }, tag),
			params: {},
			variant: {},
			progress: {
				save: (i) => lines.push(`${tag}.save ${i}`),
				clear: () => lines.push(`${tag}.clear`),
			},
		});
	const a = make('A', 'a1');
	const ra = a.run();
	await new Promise((resolve) => setTimeout(resolve, 30));
	a.stop();
	const b = make('B', 'b1');
	const rb = b.run();
	await ra;
	await new Promise((resolve) => setTimeout(resolve, 30));
	b.stop();
	await rb;
	expect(lines.slice(0, 7)).toEqual([
		'A.save 0',
		'A.show a1',
		'A.clear',
		'A.hide',
		'B.save 0',
		'B.show b1',
		'B.clear',
	]);
});

test('step pace delays a scripted action but not a human one; the run pace delays both', async () => {
	const paced = ir([step('s', { pace: { beforeAction: 250 } })]);
	const scripted = await timed(engineFor(paced, newLog()).run());
	expect(scripted.elapsed).toBeGreaterThanOrEqual(240);
	const log = newLog();
	const human = await timed(
		engineFor(paced, log, { actor: actorLogging(log, { human: true }) }).run(),
	);
	expect(human.elapsed).toBeLessThan(200);
	const configured = newLog();
	const run = await timed(
		engineFor(ir([step('s')]), configured, {
			actor: actorLogging(configured, { human: true }),
			pace: { beforeAction: 250 },
		}).run(),
	);
	expect(run.elapsed).toBeGreaterThanOrEqual(240);
});

test('a scripted run switches presenters per step and hides the one it leaves', async () => {
	const log = newLog();
	const presenters = { spot: recorder(log, 'spot'), doc: recorder(log, 'doc') } as Record<
		string,
		Presenter
	>;
	const journey = ir([step('a', { presenter: 'spot' }), step('b')]);
	await engineFor(journey, log, {
		presenter: presenters.doc as Presenter,
		presenterFor: (name) => presenters[name] as Presenter,
	}).run();
	expect(log.lines.filter((l) => /^(spot|doc)\./.test(l))).toEqual([
		'doc.hide',
		'spot.show a',
		'spot.settle a',
		'spot.hide',
		'doc.show b',
		'doc.settle b',
		'doc.hide',
	]);
	const human = newLog();
	await engineFor(journey, human, {
		actor: actorLogging(human, { human: true }),
		presenter: recorder(human, 'guide'),
		presenterFor: (name) => recorder(human, name),
	}).run();
	expect(human.lines.filter((l) => l.includes('.show'))).toEqual(['guide.show a', 'guide.show b']);
});

test('a human step whose element is re-rendered is re-resolved and waited on again', async () => {
	const first = journeyEl(dom, 'save');
	const performedOn: Element[] = [];
	let second: FakeElement | undefined;
	const human: Actor = {
		human: true,
		async navigate() {},
		perform: (_s, el, _a, ctx) =>
			new Promise((resolve) => {
				performedOn.push(el as Element);
				if (performedOn.length === 1) {
					setTimeout(() => {
						first.remove();
						second = journeyEl(dom, 'save');
					}, 20);
					ctx.signal.addEventListener('abort', () => resolve());
				} else resolve();
			}),
	};
	const result = await engineFor(
		ir([step('s', { target: 'save', do: { kind: 'click' }, timeout: 2000 })]),
		newLog(),
		{
			actor: human,
		},
	).run();
	expect(result.ok).toBe(true);
	expect(performedOn).toEqual([first, second]);
});

test('a slow moveCursor fails the step at its timeout', async () => {
	journeyEl(dom, 'b');
	const log = newLog();
	const result = await engineFor(ir([step('s', { target: 'b', do: { kind: 'click' } })]), log, {
		presenter: { ...recorder(log), moveCursor: () => new Promise(() => {}) },
	}).run();
	expect(result.failures).toEqual([
		{ stepId: 's', error: 'presenter moveCursor: no result after 200ms' },
	]);
});

test('ripple follows a click on the resolved element', async () => {
	const button = journeyEl(dom, 'b');
	const rippled: Element[] = [];
	const log = newLog();
	await engineFor(ir([step('s', { target: 'b', do: { kind: 'click' } })]), log, {
		presenter: { ...recorder(log), ripple: (el) => rippled.push(el) },
	}).run();
	expect(rippled).toEqual([button]);
});

test('the engine masks configured targets while it runs and unmasks them when a guide ends', async () => {
	const secret = journeyEl(dom, 'secret');
	const seen: Array<string | null> = [];
	const log = newLog();
	const watch = actorLogging(log, {
		async perform() {
			seen.push(secret.getAttribute('data-journey-mask'));
		},
	});
	await engineFor(ir([step('s')], { mask: ['secret'] }), log, { actor: watch, mask: true }).run();
	expect(seen).toEqual(['']);
	expect(secret.hasAttribute('data-journey-mask')).toBe(true);
	expect(dom.document.getElementById('journey-mask-style')).not.toBeNull();

	secret.removeAttribute('data-journey-mask');
	seen.length = 0;
	await engineFor(ir([step('s')], { mask: ['secret'] }), log, { actor: watch }).run();
	expect(seen).toEqual([null]);
});

test('a masked fill keeps its field masked for the run and clears the mask after it', async () => {
	const pin = journeyEl(dom, 'pin', { tag: 'input' });
	const seen: Array<string | null> = [];
	const log = newLog();
	const action: Interaction = { kind: 'fill', value: { $param: 'pin' }, mask: true };
	await engineFor(ir([step('pin', { target: 'pin', do: action }), step('after')]), log, {
		params: { pin: '4242' },
		actor: actorLogging(log, {
			async perform() {
				seen.push(pin.getAttribute('data-journey-mask'));
			},
		}),
	}).run();
	expect(seen).toEqual(['', '']);
	expect(pin.hasAttribute('data-journey-mask')).toBe(false);
});
