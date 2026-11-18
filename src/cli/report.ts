import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type VideoFormat = 'webm' | 'mp4' | 'gif';

export interface ManifestCapture {
	index: number;
	name: string;
	file: string;
	title?: string;
	body?: string;
}

export interface ManifestVariant {
	captures: ManifestCapture[];
	video?: Partial<Record<VideoFormat, string>>;
	captions?: string;
	storyboard?: string;
}

export interface Manifest {
	id: string;
	title: string;
	version: number;
	variants: Record<string, ManifestVariant>;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function prefixFiles(variant: ManifestVariant, prefix: string): ManifestVariant {
	const join = (file: string): string => `${prefix}/${file}`;
	const out: ManifestVariant = {
		captures: variant.captures.map((c) => ({ ...c, file: join(c.file) })),
	};
	if (variant.video) {
		out.video = {};
		for (const [format, file] of Object.entries(variant.video)) {
			out.video[format as VideoFormat] = join(file);
		}
	}
	if (variant.captions) out.captions = join(variant.captions);
	if (variant.storyboard) out.storyboard = join(variant.storyboard);
	return out;
}

export function renderMarkdown(manifest: Manifest, labels: Record<string, string> = {}): string {
	const lines: string[] = [`# ${manifest.title}`, ''];
	for (const [key, variant] of Object.entries(manifest.variants)) {
		lines.push(`## ${labels[key] ?? key}`, '');
		for (const capture of variant.captures) {
			lines.push(`![${capture.name}](${capture.file})`, '');
			if (capture.title) lines.push(`**${capture.title}**`, '');
			if (capture.body) lines.push(capture.body, '');
		}
		for (const [format, file] of Object.entries(variant.video ?? {})) {
			lines.push(`[Video (${format})](${file})`, '');
		}
		if (variant.captions) lines.push(`[Captions (WebVTT)](${variant.captions})`, '');
		if (variant.storyboard) lines.push(`![Storyboard](${variant.storyboard})`, '');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

const PLAYABLE: VideoFormat[] = ['mp4', 'webm'];

const STYLE = [
	'body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5}',
	'img,video{max-width:100%;height:auto}',
	'figure{margin:1.5rem 0}',
].join('');

export function renderHtmlFragment(
	manifest: Manifest,
	labels: Record<string, string> = {},
	locales: Record<string, string> = {},
): string {
	const lines: string[] = [`<h1>${escapeHtml(manifest.title)}</h1>`];
	for (const [key, variant] of Object.entries(manifest.variants)) {
		lines.push(`<h2>${escapeHtml(labels[key] ?? key)}</h2>`);
		for (const capture of variant.captures) {
			const caption = [
				capture.title ? `<strong>${escapeHtml(capture.title)}</strong>` : '',
				capture.body ? escapeHtml(capture.body) : '',
			]
				.filter(Boolean)
				.join(' ');
			lines.push(
				'<figure>',
				`<img src="${escapeHtml(capture.file)}" alt="${escapeHtml(capture.name)}">`,
				caption ? `<figcaption>${caption}</figcaption>` : '',
				'</figure>',
			);
		}
		const video = variant.video ?? {};
		const playable = PLAYABLE.filter((format) => video[format]);
		if (playable.length) {
			const lang = locales[key];
			lines.push(
				'<video controls preload="metadata">',
				...playable.map(
					(format) =>
						`<source src="${escapeHtml(video[format] as string)}" type="video/${format}">`,
				),
				variant.captions
					? `<track kind="captions" src="${escapeHtml(variant.captions)}"${lang ? ` srclang="${escapeHtml(lang)}"` : ''} label="${escapeHtml(lang ?? 'Captions')}" default>`
					: '',
				'</video>',
			);
		}
		for (const [format, file] of Object.entries(video)) {
			lines.push(`<p><a href="${escapeHtml(file)}">Video (${escapeHtml(format)})</a></p>`);
		}
		if (variant.captions) {
			lines.push(`<p><a href="${escapeHtml(variant.captions)}">Captions (WebVTT)</a></p>`);
		}
		if (variant.storyboard) {
			lines.push(
				'<figure>',
				`<img src="${escapeHtml(variant.storyboard)}" alt="Storyboard">`,
				'<figcaption>Storyboard</figcaption>',
				'</figure>',
			);
		}
	}
	return `${lines.filter(Boolean).join('\n')}\n`;
}

export function renderHtml(
	manifest: Manifest,
	labels: Record<string, string> = {},
	locales: Record<string, string> = {},
): string {
	const langs = new Set(Object.keys(manifest.variants).map((key) => locales[key]));
	const lang = langs.size === 1 ? [...langs][0] : undefined;
	return [
		'<!doctype html>',
		lang ? `<html lang="${escapeHtml(lang)}">` : '<html>',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(manifest.title)}</title>`,
		`<style>${STYLE}</style>`,
		'</head>',
		'<body>',
		renderHtmlFragment(manifest, labels, locales).trimEnd(),
		'</body>',
		'</html>',
		'',
	].join('\n');
}

export function writeManifest(dir: string, manifest: Manifest): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'manifest.json');
	writeFileSync(file, `${JSON.stringify(manifest, null, '\t')}\n`);
	return file;
}

export function writeReport(
	dir: string,
	manifest: Manifest,
	labels: Record<string, string> = {},
	locales: Record<string, string> = {},
): string[] {
	mkdirSync(dir, { recursive: true });
	const md = join(dir, 'index.md');
	const html = join(dir, 'index.html');
	writeFileSync(md, renderMarkdown(manifest, labels));
	writeFileSync(html, renderHtml(manifest, labels, locales));
	return [md, html];
}
