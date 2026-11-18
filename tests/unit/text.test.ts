import { expect, test } from '@playwright/test';
import {
	DEFAULT_STRINGS,
	defaultLocalize,
	interpolate,
	resolveStrings,
	translator,
} from '../../src/runtime/strings.js';
import {
	currentLocale,
	isParamRef,
	resolveParam,
	resolveStepParams,
	resolveText,
} from '../../src/runtime/text.js';
import { installDom } from './fake-dom.js';

test('plain text is returned as is and undefined stays undefined', () => {
	expect(resolveText('Save', undefined, 'fr')).toBe('Save');
	expect(resolveText(undefined, undefined, 'fr')).toBeUndefined();
});

test('a locale table picks the locale, then English, then its first entry', () => {
	const table = { fr: 'Enregistrer', en: 'Save', ja: '保存' };
	expect(resolveText(table, undefined, 'ja')).toBe('保存');
	expect(resolveText(table, undefined, 'de')).toBe('Save');
	expect(resolveText(table, undefined, undefined)).toBe('Save');
	expect(resolveText({ fr: 'Enregistrer', ja: '保存' }, undefined, 'de')).toBe('Enregistrer');
	expect(resolveText({}, undefined, 'de')).toBeUndefined();
});

test('a message id goes through translate with the locale, falling back to the id', () => {
	const calls: string[] = [];
	const translate = (id: string, locale: string) => {
		calls.push(`${id}@${locale}`);
		return id === 'save' ? `save(${locale})` : undefined;
	};
	expect(resolveText({ $msg: 'save' }, translate, 'fr')).toBe('save(fr)');
	expect(resolveText({ $msg: 'save' }, translate, undefined)).toBe('save(en)');
	expect(resolveText({ $msg: 'missing' }, translate, 'fr')).toBe('missing');
	expect(resolveText({ $msg: 'save' }, undefined, 'fr')).toBe('save');
	expect(calls).toEqual(['save@fr', 'save@en', 'missing@fr']);
});

test('the locale comes from the variant, else the document language, else none', () => {
	expect(currentLocale({ locale: 'ja' })).toBe('ja');
	expect(currentLocale()).toBeUndefined();
	const dom = installDom();
	try {
		expect(currentLocale()).toBeUndefined();
		Object.defineProperty(dom.document.documentElement, 'lang', { value: 'fr' });
		expect(currentLocale()).toBe('fr');
		expect(currentLocale({ locale: 'ja' })).toBe('ja');
	} finally {
		dom.restore();
	}
});

test('params resolve from the run params and a missing one names itself', () => {
	expect(resolveParam('literal', {})).toBe('literal');
	expect(resolveParam({ $param: 'name' }, { name: 'Ada' })).toBe('Ada');
	expect(resolveParam({ $param: 'name' }, { name: '' })).toBe('');
	expect(() => resolveParam({ $param: 'var.key' }, {})).toThrow('Unresolved param "var.key"');
	expect(resolveStepParams({ id: { $param: 'row' }, fixed: 'x' }, { row: '7' })).toEqual({
		id: '7',
		fixed: 'x',
	});
	expect(resolveStepParams(undefined, {})).toEqual({});
	expect(() => resolveStepParams({ id: { $param: 'row' } }, {})).toThrow('Unresolved param "row"');
});

test('only objects with a string $param are param refs', () => {
	expect(isParamRef({ $param: 'x' })).toBe(true);
	expect(isParamRef({ $param: 1 })).toBe(false);
	expect(isParamRef('x')).toBe(false);
	expect(isParamRef(null)).toBe(false);
});

test('overlay strings merge over the defaults, statically or per locale', () => {
	expect(resolveStrings(undefined, 'fr')).toEqual(DEFAULT_STRINGS);
	expect(resolveStrings({ next: 'Suivant' }, 'fr')).toEqual({
		...DEFAULT_STRINGS,
		next: 'Suivant',
	});
	const perLocale = (locale: string | undefined) => (locale === 'fr' ? { exit: 'Quitter' } : {});
	expect(resolveStrings(perLocale, 'fr').exit).toBe('Quitter');
	expect(resolveStrings(perLocale, 'en').exit).toBe('Exit');
});

test('interpolation fills known placeholders and leaves unknown ones visible', () => {
	expect(interpolate('Step {i} of {n}', { i: 2, n: 5 })).toBe('Step 2 of 5');
	expect(interpolate('Open {route} {later}', { route: '/a' })).toBe('Open /a {later}');
	expect(defaultLocalize('step', { i: 1, n: 3 })).toBe('Step 1 of 3');
	let strings = { ...DEFAULT_STRINGS, next: 'Weiter' };
	const localize = translator(() => strings);
	expect(localize('next')).toBe('Weiter');
	strings = { ...strings, next: 'Suivant' };
	expect(localize('next')).toBe('Suivant');
});
