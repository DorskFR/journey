import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(root, '..', 'dist');
const port = Number(process.argv[2]) || 4177;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

const BUNDLES = new Set(['/runtime.iife.js', '/editor.iife.js']);

function fileFor(pathname) {
	if (BUNDLES.has(pathname)) return join(dist, pathname);
	const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
	const file = join(root, clean === '/' || clean === '\\' ? 'index.html' : clean);
	return file.startsWith(root) ? file : null;
}

createServer((req, res) => {
	const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
	const file = fileFor(pathname);
	const type = file ? MIME[extname(file)] : undefined;
	let ok = false;
	try {
		ok = Boolean(file && type && statSync(file).isFile());
	} catch {
		ok = false;
	}
	if (!ok || !file) {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Not found');
		return;
	}
	res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	createReadStream(file).pipe(res);
}).listen(port, () => {
	console.log(`demo at http://localhost:${port}/`);
});
