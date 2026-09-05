import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../src/version.ts', import.meta.url);
const next = `export const VERSION = '${version}';\n`;
let current = '';
try {
	current = readFileSync(file, 'utf8');
} catch {}
if (current !== next) writeFileSync(file, next);
