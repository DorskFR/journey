/**
 * Just enough DOM for the runtime to resolve `data-journey` targets, read
 * values and dispatch events under Node. Selectors: `*`, `tag`,
 * `[attr="value"]`, `[attr]`, `:disabled` and comma lists of those.
 */

const SIMPLE = /^([a-z0-9]*)((?:\[[^\]]+\])*)(:disabled)?$/i;
const ATTRIBUTE = /\[([^\]=]+)(?:=(?:"((?:[^"\\]|\\.)*)"|([^\]"]*)))?\]/g;

function simpleMatch(el: FakeElement, selector: string): boolean {
	if (selector === '*') return true;
	const m = SIMPLE.exec(selector);
	if (!m) return false;
	const [, tag, attrs = '', disabled] = m;
	if (tag && tag.toLowerCase() !== el.localName) return false;
	if (disabled && !el.disabled) return false;
	for (const [, name = '', quoted, bare] of attrs.matchAll(ATTRIBUTE)) {
		const actual = el.getAttribute(name);
		if (actual === null) return false;
		const wanted = quoted === undefined ? bare : quoted.replace(/\\(.)/g, '$1');
		if (wanted !== undefined && actual !== wanted) return false;
	}
	return true;
}

export class FakeElement extends EventTarget {
	readonly localName: string;
	readonly attrs = new Map<string, string>();
	readonly children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	shadowRoot = null;
	ownText = '';
	disabled = false;
	hidden = false;
	checked = false;
	private current = '';
	readonly doc: FakeDocument;

	constructor(doc: FakeDocument, tag: string, attrs: Record<string, string> = {}) {
		super();
		this.doc = doc;
		this.localName = tag.toLowerCase();
		for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
	}

	get value(): string {
		return this.current;
	}

	set value(value: string) {
		this.current = value;
	}

	get type(): string {
		return this.getAttribute('type') ?? '';
	}

	get tagName(): string {
		return this.localName.toUpperCase();
	}

	get ownerDocument(): FakeDocument {
		return this.doc;
	}

	get id(): string {
		return this.getAttribute('id') ?? '';
	}

	set id(value: string) {
		this.setAttribute('id', value);
	}

	get isContentEditable(): boolean {
		return false;
	}

	get textContent(): string {
		return this.ownText + this.children.map((c) => c.textContent).join('');
	}

	set textContent(value: string) {
		this.ownText = value;
		for (const child of this.children) child.parentElement = null;
		this.children.length = 0;
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, String(value));
	}

	hasAttribute(name: string): boolean {
		return this.attrs.has(name);
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	append(...els: FakeElement[]): void {
		for (const el of els) {
			el.remove();
			el.parentElement = this;
			this.children.push(el);
		}
	}

	remove(): void {
		const parent = this.parentElement;
		if (!parent) return;
		parent.children.splice(parent.children.indexOf(this), 1);
		this.parentElement = null;
	}

	get isConnected(): boolean {
		let node: FakeElement | null = this;
		while (node.parentElement) node = node.parentElement;
		return node === this.doc.documentElement;
	}

	contains(other: unknown): boolean {
		for (let node = other as FakeElement | null; node; node = node.parentElement) {
			if (node === this) return true;
		}
		return false;
	}

	descendants(): FakeElement[] {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}

	matches(selector: string): boolean {
		return selector.split(',').some((part) => simpleMatch(this, part.trim()));
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.descendants().filter((el) => el.matches(selector));
	}

	getRootNode(): FakeDocument {
		return this.doc;
	}

	getBoundingClientRect(): DOMRect {
		const size = this.hidden ? 0 : 20;
		return {
			x: 10,
			y: 10,
			left: 10,
			top: 10,
			width: size * 5,
			height: size,
			right: 10 + size * 5,
			bottom: 10 + size,
			toJSON() {},
		};
	}

	getClientRects(): DOMRect[] {
		return this.hidden ? [] : [this.getBoundingClientRect()];
	}

	focus(): void {
		this.doc.activeElement = this;
	}

	blur(): void {
		if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
	}
}

export class FakeInput extends FakeElement {
	form = null;
	labels = undefined;
	select(): void {}
}

export class FakeTextArea extends FakeInput {}

export class FakeSelect extends FakeElement {
	get options(): Array<{ value: string; label: string; text: string }> {
		return this.children.map((o) => ({
			value: o.getAttribute('value') ?? o.textContent,
			label: o.getAttribute('label') ?? o.textContent,
			text: o.textContent,
		}));
	}
}

export class FakeDocument {
	readonly documentElement: FakeElement;
	readonly head: FakeElement;
	readonly body: FakeElement;
	activeElement: FakeElement | null = null;
	defaultView: unknown = undefined;

	constructor() {
		this.documentElement = new FakeElement(this, 'html');
		this.head = new FakeElement(this, 'head');
		this.body = new FakeElement(this, 'body');
		this.documentElement.append(this.head, this.body);
		this.activeElement = this.body;
	}

	createElement(tag: string, attrs: Record<string, string> = {}): FakeElement {
		const name = tag.toLowerCase();
		if (name === 'input') return new FakeInput(this, name, attrs);
		if (name === 'textarea') return new FakeTextArea(this, name, attrs);
		if (name === 'select') return new FakeSelect(this, name, attrs);
		return new FakeElement(this, name, attrs);
	}

	querySelectorAll(selector: string): FakeElement[] {
		return [this.documentElement, ...this.documentElement.querySelectorAll(selector)].filter((el) =>
			el.matches(selector),
		);
	}

	getElementById(id: string): FakeElement | null {
		return this.querySelectorAll(`[id="${id}"]`)[0] ?? null;
	}

	execCommand(): boolean {
		return false;
	}
}

/** Builds `<tag data-journey="name">` under `parent` (the body by default). */
export function journeyEl(
	dom: FakeDom,
	name: string,
	opts: { tag?: string; key?: string; text?: string; parent?: FakeElement } = {},
): FakeElement {
	const attrs: Record<string, string> = { 'data-journey': name };
	if (opts.key !== undefined) attrs['data-journey-key'] = opts.key;
	const el = dom.document.createElement(opts.tag ?? 'div', attrs);
	if (opts.text !== undefined) el.ownText = opts.text;
	(opts.parent ?? dom.document.body).append(el);
	return el;
}

function eventClass(): typeof Event {
	return class extends Event {
		constructor(type: string, init: EventInit = {}) {
			super(type, init);
			for (const [key, value] of Object.entries(init)) {
				if (!(key in Event.prototype)) Object.defineProperty(this, key, { value });
			}
		}
	};
}

export interface FakeLocation {
	pathname: string;
	hash: string;
	search: string;
	href: string;
	assigned: string[];
}

export interface FakeDom {
	document: FakeDocument;
	window: EventTarget & Record<string, unknown>;
	location: FakeLocation;
	restore(): void;
}

const GLOBALS = [
	'window',
	'document',
	'location',
	'CSS',
	'HTMLElement',
	'SVGElement',
	'HTMLInputElement',
	'HTMLTextAreaElement',
	'HTMLSelectElement',
	'MouseEvent',
	'PointerEvent',
	'KeyboardEvent',
	'InputEvent',
	'getSelection',
] as const;

/** Installs the fake DOM on globalThis; `restore()` puts the previous globals back. */
export function installDom(url = 'http://app.test/'): FakeDom {
	const g = globalThis as Record<string, unknown>;
	const saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(g, name)]));
	const document = new FakeDocument();
	const win = Object.assign(new EventTarget(), {
		getComputedStyle: (el: FakeElement) => ({
			visibility: el.getAttribute('style')?.includes('hidden') ? 'hidden' : 'visible',
		}),
	}) as unknown as EventTarget & Record<string, unknown>;
	document.defaultView = win;
	const at = new URL(url);
	const location: FakeLocation = {
		pathname: at.pathname,
		hash: at.hash,
		search: at.search,
		assigned: [],
		get href() {
			return `${at.origin}${this.pathname}${this.search}${this.hash}`;
		},
		set href(value: string) {
			this.assigned.push(value);
		},
	};
	const values: Record<(typeof GLOBALS)[number], unknown> = {
		window: win,
		document,
		location,
		CSS: { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
		HTMLElement: FakeElement,
		SVGElement: class {},
		HTMLInputElement: FakeInput,
		HTMLTextAreaElement: FakeTextArea,
		HTMLSelectElement: FakeSelect,
		MouseEvent: eventClass(),
		PointerEvent: eventClass(),
		KeyboardEvent: eventClass(),
		InputEvent: eventClass(),
		getSelection: () => null,
	};
	for (const name of GLOBALS) {
		Object.defineProperty(g, name, { value: values[name], configurable: true, writable: true });
		if (name !== 'window') win[name] = values[name];
	}
	win.Event = Event;
	return {
		document,
		window: win,
		location,
		restore() {
			for (const [name, descriptor] of saved) {
				if (descriptor) Object.defineProperty(g, name, descriptor);
				else delete g[name];
			}
		},
	};
}
