import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { waitForUrl } from '../../src/playwright/fixtures.js';

function dead(): Promise<ChildProcess> {
	const child = spawn('exit 1', { shell: true, stdio: 'ignore' });
	return new Promise((done) => child.on('exit', () => done(child)));
}

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((done) => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			done({
				url: `http://127.0.0.1:${port}/`,
				close: () => new Promise((closed) => server.close(() => closed())),
			});
		});
	});
}

test('a start command that lost the port to an app already serving it is not a failure', async () => {
	const app = await serve();
	try {
		await waitForUrl(app.url, 5000, await dead());
	} finally {
		await app.close();
	}
});

test('a start command that never serves the url still fails', async () => {
	await expect(waitForUrl('http://127.0.0.1:9/', 5000, await dead())).rejects.toThrow(
		/exited with code 1/,
	);
});
