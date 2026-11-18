import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { pageEntries } from '../../src/cli/pages.js';
import { type Manifest, renderHtml, renderMarkdown } from '../../src/cli/report.js';
import { captureStep } from '../../src/playwright/capture.js';

function fakePage(failures: string[]) {
	const calls = { shots: 0, waits: 0 };
	return {
		calls,
		page: {
			async screenshot() {
				calls.shots += 1;
				const message = failures.shift();
				if (message) throw new Error(message);
				return Buffer.from('png');
			},
			async waitForTimeout() {
				calls.waits += 1;
			},
			viewportSize: () => ({ width: 1280, height: 800 }),
		} as unknown as Page,
	};
}

const spec = { name: 'a' };
const ctx = { index: 0, stepId: 'a', rect: null };

const TRANSIENT =
	'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';

test('a transient screenshot protocol error is retried before the capture fails', async () => {
	const once = fakePage([TRANSIENT]);
	expect((await captureStep(once.page, spec, ctx)).toString()).toBe('png');
	expect(once.calls).toEqual({ shots: 2, waits: 1 });

	const always = fakePage(Array(3).fill(TRANSIENT));
	await expect(captureStep(always.page, spec, ctx)).rejects.toThrow('Unable to capture screenshot');
	expect(always.calls.shots).toBe(3);

	const other = fakePage(['Target page, context or browser has been closed']);
	await expect(captureStep(other.page, spec, ctx)).rejects.toThrow('has been closed');
	expect(other.calls).toEqual({ shots: 1, waits: 0 });
});

const manifest: Manifest = {
	id: 'j',
	title: 'メモ & notes',
	version: 1,
	variants: {
		'desktop-ja': {
			captures: [{ index: 0, name: 'a', file: '01-a.png', title: 'ようこそ', body: 'b' }],
			video: { webm: 'tour.webm', mp4: 'tour.mp4' },
			captions: 'tour.vtt',
			storyboard: 'storyboard.png',
		},
	},
};

test('index.html is a standalone utf-8 page with the video, its captions and the storyboard', () => {
	const html = renderHtml(manifest, { 'desktop-ja': 'desktop ja' }, { 'desktop-ja': 'ja' });
	expect(html.startsWith('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">')).toBe(
		true,
	);
	expect(html).toContain('<title>メモ &amp; notes</title>');
	expect(html).toContain('<h2>desktop ja</h2>');
	expect(html).toMatch(
		/<video controls[^>]*>\n<source src="tour.mp4" type="video\/mp4">\n<source src="tour.webm" type="video\/webm">\n<track kind="captions" src="tour.vtt" srclang="ja" label="ja" default>\n<\/video>/,
	);
	expect(html).toContain('<img src="storyboard.png" alt="Storyboard">');
	expect(html).not.toMatch(/(src|href)="(\/|https?:)/);
	expect(html.trimEnd().endsWith('</body>\n</html>')).toBe(true);
	expect(renderHtml({ ...manifest, variants: {} })).toContain('<html>\n');
});

test('index.md links the captions and the storyboard', () => {
	const md = renderMarkdown(manifest);
	expect(md).toContain('[Captions (WebVTT)](tour.vtt)');
	expect(md).toContain('![Storyboard](storyboard.png)');
});

test('a page can name a fixture, and an unknown one fails before anything runs', () => {
	const entries = pageEntries({
		fixtures: { signedIn: { storageState: 'state.json' } },
		pages: ['/', { route: '/account', fixture: 'signedIn' } as { route: string }],
	});
	expect(entries.map((e) => e.fixture)).toEqual([undefined, 'signedIn']);
	expect(() =>
		pageEntries({ pages: [{ route: '/account', fixture: 'nope' } as { route: string }] }),
	).toThrow('journey pages: fixture "nope" of /account is not defined in the config');
});
