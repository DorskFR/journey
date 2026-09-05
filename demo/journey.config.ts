import { defineConfig } from '@dorsk/journey';

export default defineConfig({
	app: { url: 'http://localhost:4177', start: 'node serve.mjs 4177' },
	journeys: 'journeys/*.journey.ts',
	out: 'out',
	variants: {
		viewport: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } },
		theme: ['light', 'dark'],
	},
	vars: { title: 'Buy milk' },
	pages: ['/', '/#notes', '/settings.html'],
});
