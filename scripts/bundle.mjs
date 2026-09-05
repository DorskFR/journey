import { build } from 'esbuild';

const shared = {
	bundle: true,
	format: 'iife',
	target: 'es2022',
	platform: 'browser',
	legalComments: 'none',
	logLevel: 'info',
};

await build({
	...shared,
	entryPoints: ['src/runtime/index.ts'],
	outfile: 'dist/runtime.iife.js',
	globalName: 'journeyRuntime',
});
await build({
	...shared,
	entryPoints: ['src/editor/index.ts'],
	outfile: 'dist/editor.iife.js',
	globalName: 'journeyEditor',
});
