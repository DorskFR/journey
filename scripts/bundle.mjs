import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const browser = {
	bundle: true,
	format: 'iife',
	target: 'es2022',
	platform: 'browser',
	legalComments: 'none',
	minify: true,
	logLevel: 'info',
};

await build({
	...browser,
	entryPoints: ['src/runtime/index.ts'],
	outfile: 'dist/runtime.iife.js',
	globalName: 'journeyRuntime',
	footer: { js: 'window.journeyRuntime = journeyRuntime;' },
});
await build({
	...browser,
	entryPoints: ['src/editor/index.ts'],
	outfile: 'dist/editor.iife.js',
	globalName: 'journeyEditor',
	footer: { js: 'window.journeyEditor = journeyEditor;' },
});

// CommonJS copies for user files that Playwright transpiles to CommonJS.
const cjs = {
	bundle: true,
	format: 'cjs',
	target: 'es2022',
	platform: 'node',
	legalComments: 'none',
	logLevel: 'info',
	define: { 'import.meta.url': '__importMetaUrl' },
	banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
};

await build({ ...cjs, entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs' });
const PEER_HELP = JSON.stringify(
	'@dorsk/journey/playwright needs @playwright/test. Install it with:  npm i -D @playwright/test',
);

await build({
	...cjs,
	entryPoints: ['src/playwright/index.ts'],
	outfile: 'dist/playwright/index.cjs',
	external: ['@playwright/test'],
	banner: {
		js: `${cjs.banner.js}\ntry { require.resolve("@playwright/test"); } catch { throw new Error(${PEER_HELP}); }`,
	},
});

const surface = await build({
	entryPoints: ['src/playwright/index.ts'],
	outfile: 'dist/playwright/entry.js',
	bundle: true,
	format: 'esm',
	platform: 'node',
	packages: 'external',
	metafile: true,
	write: false,
	logLevel: 'silent',
});
const names = Object.values(surface.metafile.outputs).flatMap((output) => output.exports);
if (!names.includes('test')) throw new Error('bundle: could not list the playwright entry exports');
writeFileSync(
	'dist/playwright/entry.js',
	`let mod;
try {
	mod = await import('./index.js');
} catch (error) {
	if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes("'@playwright/test'")) {
		throw new Error(${PEER_HELP}, { cause: error });
	}
	throw error;
}
export const { ${names.join(', ')} } = mod;
`,
);

// CommonJS consumers resolve `require` types to .d.cts copies, so TypeScript
// reads them as CommonJS instead of as ES modules in a "type": "module" package.
const RELATIVE = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)\.js(['"])/g;
const pending = ['dist/index.d.ts', 'dist/playwright/index.d.ts'];
const seen = new Set();
while (pending.length) {
	const file = pending.pop();
	if (seen.has(file)) continue;
	seen.add(file);
	const source = readFileSync(file, 'utf8');
	for (const [, , spec] of source.matchAll(RELATIVE)) {
		const dep = join(dirname(file), `${spec}.d.ts`);
		if (!existsSync(dep)) throw new Error(`bundle: ${file} imports ${spec}.js, no ${dep}`);
		pending.push(dep);
	}
	writeFileSync(file.replace(/\.d\.ts$/, '.d.cts'), source.replace(RELATIVE, '$1$2.cjs$3'));
}
