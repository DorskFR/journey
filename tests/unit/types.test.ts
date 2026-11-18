import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { Config, FixtureRequest } from '../../src/index.js';

const repo = resolve(import.meta.dirname, '../..');
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');

function typecheck(dir: string, name: string, config: object): string {
	const project = join(dir, name);
	writeFileSync(project, JSON.stringify(config));
	try {
		execFileSync(process.execPath, [tsc, '-p', project], {
			cwd: dir,
			encoding: 'utf8',
			stdio: 'pipe',
		});
		return '';
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(error);
	}
}

test('the root declarations typecheck without @playwright/test and with skipLibCheck off', () => {
	test.setTimeout(60000);
	const dir = mkdtempSync(join(tmpdir(), 'journey-types-'));
	try {
		const emit = typecheck(dir, 'emit.json', {
			compilerOptions: {
				module: 'nodenext',
				target: 'ES2022',
				strict: true,
				declaration: true,
				emitDeclarationOnly: true,
				rootDir: join(repo, 'src'),
				outDir: join(dir, 'decl'),
				typeRoots: [join(repo, 'node_modules', '@types')],
				types: ['node'],
			},
			files: [join(repo, 'src', 'index.ts')],
		});
		expect(emit).toBe('');
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
		writeFileSync(
			join(dir, 'consumer.ts'),
			`import type { Config } from './decl/index.js';
export const config: Config = {
	fixtures: {
		seeded: {
			async setup({ baseUrl, request }) {
				const res = await request.post(\`\${baseUrl}/api/seed\`, { data: { notes: 2 } });
				if (!res.ok()) throw new Error(String(res.status()));
				const { id } = await res.json();
				return { id: String(id) };
			},
		},
	},
};
`,
		);
		const consumer = typecheck(dir, 'consumer.json', {
			compilerOptions: {
				module: 'nodenext',
				target: 'ES2022',
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				types: [],
			},
			files: [join(dir, 'consumer.ts')],
		});
		expect(consumer).toBe('');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a Playwright request context is a fixture request', () => {
	const setup: NonNullable<NonNullable<Config['fixtures']>[string]['setup']> = async ({
		request,
	}) => {
		const res = await request.get<{ id: number }>('/api/me');
		const me: { id: number } = await res.json();
		return { id: String(me.id) };
	};
	const fromPlaywright = (request: APIRequestContext): FixtureRequest => request;
	expect(typeof setup).toBe('function');
	expect(typeof fromPlaywright).toBe('function');
});
