import { expect, type Page, test } from '@playwright/test';
import { BASE, mountRuntime, RUNTIME_INIT, waitForApi } from './helpers.js';

type PartName = 'spot' | 'badge' | 'card' | 'toast';

function styleOf(page: Page, part: PartName, prop: string): Promise<string> {
	return page.evaluate(
		([name, property]) => {
			const api = window.__journey as NonNullable<typeof window.__journey>;
			const el = api.overlay.parts[name as 'badge'];
			return getComputedStyle(el).getPropertyValue(property);
		},
		[part, prop] as const,
	);
}

function setTokens(page: Page, tokens: Record<string, string>): Promise<void> {
	return page.evaluate((entries) => {
		for (const [name, value] of Object.entries(entries)) {
			document.documentElement.style.setProperty(name, value);
		}
	}, tokens);
}

test.beforeEach(async ({ context, page }) => {
	await context.addInitScript(RUNTIME_INIT);
	await page.goto(`${BASE}/#notes`);
	await mountRuntime(page);
	await waitForApi(page);
});

test('the overlay keeps its built-in palette when the host sets nothing', async ({ page }) => {
	expect(await styleOf(page, 'badge', 'background-color')).toBe('rgb(255, 209, 102)');
	expect(await styleOf(page, 'card', 'background-color')).toBe('rgb(255, 255, 255)');
	expect(await styleOf(page, 'card', 'color')).toBe('rgb(17, 17, 17)');
	expect(await styleOf(page, 'toast', 'background-color')).toBe('rgb(17, 17, 17)');
});

test('host custom properties inherit through the shadow boundary', async ({ page }) => {
	await setTokens(page, {
		'--journey-accent': '#0000ff',
		'--journey-surface': '#102030',
		'--journey-text': '#fafafa',
		'--journey-inverse-surface': '#405060',
	});

	expect(await styleOf(page, 'badge', 'background-color')).toBe('rgb(0, 0, 255)');
	expect(await styleOf(page, 'card', 'background-color')).toBe('rgb(16, 32, 48)');
	expect(await styleOf(page, 'card', 'color')).toBe('rgb(250, 250, 250)');
	expect(await styleOf(page, 'toast', 'background-color')).toBe('rgb(64, 80, 96)');
});

test('the spotlight ring and scrim follow their tokens', async ({ page }) => {
	await setTokens(page, {
		'--journey-accent': '#00ff00',
		'--journey-scrim': 'rgba(1, 2, 3, 0.5)',
	});

	const shadow = await styleOf(page, 'spot', 'box-shadow');
	expect(shadow).toContain('rgb(0, 255, 0)');
	expect(shadow).toContain('rgba(1, 2, 3, 0.5)');
});
