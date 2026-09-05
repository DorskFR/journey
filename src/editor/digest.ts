import type { Expectation, Target } from '../core/types.js';
import { locate } from './locate.js';
import { collapse, currentRoute, runtime } from './runtime.js';

export interface Digest {
	url: string;
	dialogs: string[];
	alerts: string[];
	headings: string[];
	counts: Record<string, number>;
	focused: string | null;
	targets: Record<string, Target>;
}

export interface Suggested {
	label: string;
	expectation: Expectation;
}

function dialogName(el: Element): string {
	const { accessibleName } = runtime();
	const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
	const fromHeading = heading ? collapse(heading.textContent) : '';
	const aria = collapse(el.getAttribute('aria-label'));
	return aria || fromHeading || accessibleName(el);
}

function keyedCounts(): Record<string, number> {
	const { isVisible } = runtime();
	const counts: Record<string, number> = {};
	for (const container of document.querySelectorAll('[data-journey]')) {
		const groups = new Map<string, number>();
		for (const child of container.querySelectorAll('[data-journey][data-journey-key]')) {
			if (child.parentElement?.closest('[data-journey]') !== container) continue;
			const name = child.getAttribute('data-journey') ?? '';
			groups.set(name, (groups.get(name) ?? 0) + (isVisible(child) ? 1 : 0));
		}
		if (groups.size === 0) continue;
		const base = locate(container).target;
		if (typeof base !== 'string') continue;
		for (const [name, count] of groups) counts[`${base}/${name}`] = count;
	}
	return counts;
}

export function digest(): Digest {
	const { isVisible } = runtime();
	const targets: Record<string, Target> = {};
	const dialogs: string[] = [];
	for (const el of document.querySelectorAll('dialog[open],[role="dialog"]')) {
		if (!isVisible(el)) continue;
		const name = dialogName(el);
		dialogs.push(name);
		targets[`dialog:${name}`] = locate(el).target;
	}
	const alerts: string[] = [];
	for (const el of document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')) {
		if (!isVisible(el)) continue;
		const text = collapse(el.textContent);
		if (text === '') continue;
		alerts.push(text);
		targets[`alert:${text}`] = locate(el).target;
	}
	const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
		.filter(isVisible)
		.map((el) => collapse(el.textContent));
	const active = document.activeElement;
	const focused = active && active !== document.body ? JSON.stringify(locate(active).target) : null;
	return {
		url: currentRoute(),
		dialogs,
		alerts,
		headings,
		counts: keyedCounts(),
		focused,
		targets,
	};
}

export function suggest(before: Digest, after: Digest): Suggested[] {
	const out: Suggested[] = [];
	for (const name of after.dialogs) {
		if (before.dialogs.includes(name)) continue;
		const target = after.targets[`dialog:${name}`] ?? { role: 'dialog', name };
		out.push({ label: `Dialog "${name}" is visible`, expectation: { visible: target } });
	}
	if (after.url !== before.url)
		out.push({ label: `URL is ${after.url}`, expectation: { url: after.url } });
	for (const [path, count] of Object.entries(after.counts)) {
		if (before.counts[path] === count) continue;
		out.push({
			label: `${path} count is ${count}`,
			expectation: { count: [path, { equals: count }] },
		});
	}
	for (const text of after.alerts) {
		if (before.alerts.includes(text)) continue;
		const target = after.targets[`alert:${text}`];
		if (target === undefined) continue;
		out.push({ label: `"${text}" is shown`, expectation: { text: [target, text] } });
	}
	return out.slice(0, 3);
}
