import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { mergeJourneyManifest } from '../../src/cli/book.js';
import { checkVariantFilter, matchesFilter, parseVariantFilter } from '../../src/cli/config.js';
import { parseArgv } from '../../src/cli/main.js';
import { pageEntries, pageName } from '../../src/cli/pages.js';
import type { Manifest } from '../../src/cli/report.js';

const matrix = [
	{ viewport: 'desktop', theme: 'light' },
	{ viewport: 'mobile', theme: 'light' },
];

function filterOf(...pairs: string[]) {
	return parseVariantFilter(
		parseArgv(['book', ...pairs.flatMap((p) => ['--variant', p])]).flags.variant as string,
		'book',
	);
}

test('repeating a --variant dim matches any of its values', () => {
	const filter = filterOf('viewport=desktop', 'viewport=mobile');
	expect(filter).toEqual({ viewport: ['desktop', 'mobile'] });
	expect(matrix.filter((v) => matchesFilter(v, filter))).toEqual(matrix);
	expect(matrix.filter((v) => matchesFilter(v, filterOf('viewport=mobile')))).toEqual([matrix[1]]);
});

test('an unknown --variant dim or value is rejected with the valid ones', () => {
	expect(() => checkVariantFilter(filterOf('viewport=dekstop'), [matrix], 'book')).toThrow(
		'journey book: unknown viewport "dekstop", expected one of: desktop, mobile',
	);
	expect(() => checkVariantFilter(filterOf('veiwport=desktop'), [matrix], 'book')).toThrow(
		'journey book: unknown variant dim "veiwport", expected one of: viewport, theme',
	);
	expect(() =>
		checkVariantFilter(
			filterOf('viewport=mobile', 'theme=dark'),
			[matrix, [{ viewport: 'desktop', theme: 'dark' }]],
			'book',
		),
	).toThrow('no variant of the selected journeys matches --variant viewport=mobile theme=dark');
	expect(() => checkVariantFilter(filterOf('viewport=mobile'), [matrix], 'book')).not.toThrow();
});

test('booking a subset keeps the variants already booked on disk in the journey manifest', () => {
	const dir = mkdtempSync(join(tmpdir(), 'journey-merge-'));
	try {
		const capture = (file: string) => ({ captures: [{ index: 0, name: 'a', file }] });
		const previous: Manifest = {
			id: 'j',
			title: 'J',
			version: 1,
			variants: {
				'desktop-light': capture('desktop-light/01-a.png'),
				'mobile-light': capture('mobile-light/01-a.png'),
				'tablet-light': capture('tablet-light/01-a.png'),
			},
		};
		writeFileSync(join(dir, 'manifest.json'), JSON.stringify(previous));
		for (const key of ['desktop-light', 'mobile-light', 'tablet-light']) {
			mkdirSync(join(dir, key));
			writeFileSync(join(dir, key, 'manifest.json'), '{}');
		}
		rmSync(join(dir, 'mobile-light', 'manifest.json'));
		const booked: Manifest = {
			id: 'j',
			title: 'J',
			version: 2,
			variants: { 'desktop-light': capture('desktop-light/01-new.png') },
		};
		expect(mergeJourneyManifest(dir, booked, matrix).variants).toEqual({
			'desktop-light': capture('desktop-light/01-new.png'),
		});
		writeFileSync(join(dir, 'mobile-light', 'manifest.json'), '{}');
		const merged = mergeJourneyManifest(dir, booked, matrix);
		expect(merged.version).toBe(2);
		expect(Object.keys(merged.variants)).toEqual(['desktop-light', 'mobile-light']);
		expect(merged.variants['mobile-light']).toEqual(capture('mobile-light/01-a.png'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('page names are path-safe and keep the query and hash apart from the path', () => {
	const names = Object.fromEntries(
		['/', '/#notes', '/notes', '/settings.html', '/?tab=2', '/users/1/edit', '/a.b/c?x=%2F..'].map(
			(route) => [route, pageName(route)],
		),
	);
	expect(names).toEqual({
		'/': 'home',
		'/#notes': 'notes',
		'/notes': 'notes',
		'/settings.html': 'settings',
		'/?tab=2': 'tab-2',
		'/users/1/edit': 'users-1-edit',
		'/a.b/c?x=%2F..': 'a-b-c-x-2f',
	});
	for (const name of Object.values(names)) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('pages fail on two routes with one name and on names that are not path-safe', () => {
	expect(() => pageEntries({ pages: ['/notes', '/#notes'] })).toThrow(
		'journey pages: /notes and /#notes are both named "notes", give one a `name`',
	);
	expect(() => pageEntries({ pages: ['/settings', { route: '/x', name: 'Settings' }] })).toThrow(
		'both named "Settings"',
	);
	expect(() => pageEntries({ pages: [{ route: '/x', name: '../x' }] })).toThrow(
		'journey pages: name "../x" of /x must start with a letter or digit',
	);
	expect(
		pageEntries({ pages: ['/notes', { route: '/#notes', name: 'notes-tab' }] }).map((p) => p.name),
	).toEqual(['notes', 'notes-tab']);
});
