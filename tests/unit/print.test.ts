import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Journey } from '../../src/index.js';
import { compile, defineJourney, msg, param, print } from '../../src/index.js';

const tmpDir = new URL('../../tmp/', import.meta.url);
const indexUrl = pathToFileURL(new URL('../../src/index.ts', import.meta.url).pathname).href;

async function reimport(source: string, name: string): Promise<Journey> {
	mkdirSync(tmpDir, { recursive: true });
	const file = new URL(`${name}-${Date.now()}.journey.ts`, tmpDir);
	writeFileSync(file, source.replace("from '@dorsk/journey'", `from '${indexUrl}'`));
	const mod = (await import(file.href)) as { default: Journey };
	return mod.default;
}

const journey = defineJourney({
	id: 'create-note',
	title: msg('create-note.title'),
	description: { en: 'Create a note', fr: 'Créer une note' },
	variants: { viewport: ['desktop', 'mobile'] },
	level: 'checked',
	mask: ['secret'],
	autostart: { route: '/', once: true },
	steps: [
		{
			id: 'start',
			route: '/',
			target: 'start',
			do: { kind: 'click' },
			say: { title: 'Get started', body: "It's easy" },
			expect: [{ url: '/#notes' }, { visible: 'notes' }],
			capture: 'notes',
		},
		{
			id: 'fill',
			target: { role: 'textbox', name: 'Title', within: 'dialog' },
			params: { id: param('var.id'), other: 'x' },
			do: { kind: 'fill', value: param('var.title'), mask: true },
			expect: [
				{ enabled: 'dialog/save' },
				{ count: ['notes/note', { equals: 4 }] },
				{ text: ['notes/toast', msg('saved')] },
				{ checked: ['dialog/pinned', false] },
				{ probe: 'theme', equals: { nested: [1, 'two'] } },
			],
			when: { viewport: 'desktop' },
			optional: true,
			qaOnly: true,
			capture: { name: 'saved', video: true, crop: 'target' },
		},
	],
});

test('output uses tabs and single quotes', () => {
	const source = print(compile(journey));
	expect(source).toMatch(/^import \{ defineJourney, msg, param \} from '@dorsk\/journey';\n\n/);
	expect(source).toContain('\n\tsteps: [\n\t\t{\n\t\t\tid: ');
	expect(source).not.toMatch(/^ +/m);
	expect(source).not.toContain('"');
	expect(source).toContain("msg('create-note.title')");
	expect(source).toContain("param('var.title')");
	expect(source).toContain("'It\\'s easy'");
	expect(source.endsWith('});\n')).toBe(true);
});

test('only imports the helpers it uses', () => {
	const plain = compile({ id: 'p', steps: [{ id: 'a' }] });
	expect(print(plain)).toMatch(/^import \{ defineJourney \} from '@dorsk\/journey';/);
	const withMsg = compile({ id: 'p', title: msg('t'), steps: [{ id: 'a' }] });
	expect(print(withMsg)).toMatch(/^import \{ defineJourney, msg \} from/);
});

test('key order is canonical regardless of input order', () => {
	const a = compile({
		steps: [{ do: { kind: 'click' }, target: 't', id: 's' }],
		id: 'j',
		version: 2,
	});
	const b = compile({
		id: 'j',
		version: 2,
		steps: [{ id: 's', target: 't', do: { kind: 'click' } }],
	});
	expect(print(a)).toBe(print(b));
	expect(print(a).indexOf('id:')).toBeLessThan(print(a).indexOf('version:'));
});

test('print(compile(j)) round trips to deep-equal IR', async () => {
	const ir = compile(journey);
	const source = print(ir);
	const again = await reimport(source, 'round-trip');
	const ir2 = compile(again);
	expect(ir2).toEqual(ir);
	expect(print(ir2)).toBe(source);
});
