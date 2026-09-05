import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { loadConfig, outDir, resolveFrom } from '../cli/config.js';

const loaded = await loadConfig();
const app = loaded.config.app;
const out = outDir(loaded);

export default defineConfig({
	testDir: dirname(fileURLToPath(import.meta.url)),
	testMatch: 'journeys.spec.{js,ts}',
	snapshotDir: out,
	snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
	outputDir: join(out, '.test-results'),
	reporter: process.env.CI ? 'github' : 'list',
	use: { browserName: 'chromium' },
	webServer: app?.start
		? {
				command: app.start,
				url: app.ready ?? app.url,
				cwd: app.cwd ? resolveFrom(loaded, app.cwd) : loaded.dir,
				env: app.env,
				timeout: app.timeout,
				reuseExistingServer: true,
			}
		: undefined,
});
