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
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

export function renderHtml(manifest: Manifest, labels: Record<string, string> = {}): string {
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
		for (const [format, file] of Object.entries(variant.video ?? {})) {
			lines.push(`<p><a href="${escapeHtml(file)}">Video (${escapeHtml(format)})</a></p>`);
		}
	}
	return `${lines.filter(Boolean).join('\n')}\n`;
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
): string[] {
	mkdirSync(dir, { recursive: true });
	const md = join(dir, 'index.md');
	const html = join(dir, 'index.html');
	writeFileSync(md, renderMarkdown(manifest, labels));
	writeFileSync(html, renderHtml(manifest, labels));
	return [md, html];
}
