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
await build({
	...cjs,
	entryPoints: ['src/playwright/index.ts'],
	outfile: 'dist/playwright/index.cjs',
	external: ['@playwright/test'],
});
