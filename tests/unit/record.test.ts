import { expect, test } from '@playwright/test';
import { variantDir } from '../../src/cli/book.js';
import { parseArgv } from '../../src/cli/main.js';
import {
	forwardExportScript,
	fromPayload,
	recordOptions,
	scrubHar,
	secretFiles,
} from '../../src/cli/record.js';
import { compile, type IR, print } from '../../src/index.js';
import { focusSelector } from '../../src/playwright/driver.js';

const ir: IR = compile({
	id: 'login',
	steps: [
		{ id: 'user', target: 'user', do: { kind: 'fill', value: 'me' } },
		{ id: 'pw', target: 'pw', do: { kind: 'fill', value: { $param: 'var.pw' }, mask: true } },
	],
});

test('the written source is printed in node from the exported IR, never taken from the page', () => {
	const evil = "import('node:child_process').then((c) => c.execSync('touch /tmp/pwned'));\n";
	const recorded = fromPayload({ id: '../../src/x', source: evil, ir });
	expect(recorded.source).toBe(print(ir));
	expect(recorded.ir.id).toBe('login');
	expect(recorded.masked).toEqual(['pw']);
});

test('an export with an unsafe id or no IR is rejected', () => {
	expect(() => fromPayload({ ir: { ...ir, id: '../../src/x' } })).toThrow(/journey id/);
	expect(() => fromPayload({ ir: { ...ir, steps: [{ id: 'a', capture: '../x' }] } })).toThrow(
		/capture name/,
	);
	expect(() => fromPayload({ source: 'export default {}' })).toThrow(/no journey/);
	expect(() => fromPayload(null)).toThrow(/no journey/);
});

test('the page forwards only the IR', () => {
	expect(forwardExportScript()).toContain('window.__journeyExport({ ir: detail.ir })');
	expect(forwardExportScript()).not.toContain('source');
});

test('storage state is opt-in and lands outside the journeys dir', () => {
	const off = recordOptions(parseArgv(['record', 'http://x', '-o', '/p/journeys']));
	expect(off.storageState).toBe(false);
	expect(off.har).toBe(true);
	const on = recordOptions(
		parseArgv(['record', 'http://x', '-o', '/p/journeys', '--storage-state']),
	);
	expect(on.storageState).toBe(true);
	const files = secretFiles('login', { ...on, secrets: '/p/.journey' });
	expect(files.storage).toBe('/p/.journey/login.storage.json');
	expect(files.storage.startsWith('/p/journeys')).toBe(false);
	expect(files.har).toBe('/p/journeys/fixtures/login.har');
});

test('the HAR loses auth and cookie headers and any request body carrying a secret field', () => {
	const header = (name: string, value: string) => ({ name, value });
	const har = {
		log: {
			entries: [
				{
					request: {
						headers: [
							header('Authorization', 'Bearer t'),
							header('Cookie', 'sid=1'),
							header('accept', '*/*'),
						],
						cookies: [{ name: 'sid', value: '1' }],
						postData: { mimeType: 'application/x-www-form-urlencoded', text: 'user=me&pw=hunter2' },
					},
					response: {
						headers: [header('set-cookie', 'sid=2'), header('content-type', 'text/html')],
						cookies: [{}],
					},
				},
				{
					request: {
						headers: [],
						postData: { mimeType: 'application/json', text: '{"auth":{"apiToken":"abc"}}' },
					},
				},
				{
					request: {
						headers: [],
						postData: {
							mimeType: 'multipart/form-data; boundary=x',
							text: 'Content-Disposition: form-data; name="pw"\r\n\r\nhunter2',
						},
					},
				},
				{
					request: {
						headers: [],
						postData: { mimeType: 'application/json', text: '{"title":"Buy milk"}' },
					},
				},
			],
		},
	};
	const [a, b, c, d] = scrubHar(har, ['pw']).log?.entries ?? [];
	expect(a?.request?.headers).toEqual([header('accept', '*/*')]);
	expect(a?.request?.cookies).toEqual([]);
	expect(a?.request?.postData).toBeUndefined();
	expect(a?.response?.headers).toEqual([header('content-type', 'text/html')]);
	expect(b?.request?.postData).toBeUndefined();
	expect(c?.request?.postData).toBeUndefined();
	expect(d?.request?.postData?.text).toBe('{"title":"Buy milk"}');
	expect(JSON.stringify(har)).not.toMatch(/hunter2|Bearer|sid=|abc/);
});

test('book writes a variant only at <out>/<id>/<variant>', () => {
	expect(variantDir('/p/out', 'create-note', 'desktop')).toBe('/p/out/create-note/desktop');
	expect(() => variantDir('/p/out', '..', 'desktop')).toThrow(/refusing/);
	expect(() => variantDir('/p/out', 'a', '..')).toThrow(/refusing/);
	expect(() => variantDir('/p/out', 'a', '../../x')).toThrow(/refusing/);
	expect(() => variantDir('/p/out', 'a/b', 'desktop')).toThrow(/refusing/);
	expect(() => variantDir('/p/out', '/etc', 'desktop')).toThrow(/refusing/);
});

test('the focus marker selector quotes the step id', () => {
	expect(focusSelector('save')).toBe('[data-journey-focus="save"]');
	expect(focusSelector('a"b\\c')).toBe('[data-journey-focus="a\\"b\\\\c"]');
});
