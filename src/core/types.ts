export type Locale = string;
export interface MsgRef {
	$msg: string;
}
export interface ParamRef {
	$param: string;
}
export type Text = string | MsgRef | Record<Locale, string>;

export type TargetPath = string;
export interface Locator {
	role?: string;
	name?: string;
	label?: string;
	text?: string;
	testid?: string;
	css?: string;
	within?: TargetPath;
	nth?: number;
}
export type Target = TargetPath | Locator;

export type Interaction =
	| { kind: 'click' }
	| { kind: 'dblclick' }
	| { kind: 'hover' }
	| { kind: 'none' }
	| { kind: 'fill'; value: string | ParamRef; mask?: boolean }
	| { kind: 'select'; value: string | ParamRef }
	| { kind: 'check'; checked: boolean }
	| { kind: 'press'; key: string }
	| { kind: 'navigate'; url: string };

export type Expectation =
	| { visible: Target }
	| { hidden: Target }
	| { text: [Target, Text] }
	| { value: [Target, string | ParamRef] }
	| { checked: [Target, boolean] }
	| { enabled: Target }
	| { disabled: Target }
	| { url: string }
	| { count: [Target, { min?: number; max?: number; equals?: number }] }
	| { event: string }
	| { probe: string; equals?: unknown };

export interface Capture {
	name: string;
	video?: boolean;
	crop?: 'none' | 'target' | TargetPath;
}

export type Guide = 'wait-for-user' | 'next';
export type Level = 'smoke' | 'checked' | 'visual';
export type PresenterName = 'doc' | 'spot' | 'guide' | 'none';

export interface Pace {
	beforeAction?: number;
	afterSettle?: number;
}

export interface Step {
	id: string;
	route?: string;
	target?: Target;
	params?: Record<string, string | ParamRef>;
	do?: Interaction;
	guide?: Guide;
	say?: { title?: Text; body?: Text };
	expect?: Expectation[];
	capture?: string | Capture;
	when?: Record<string, string>;
	optional?: boolean;
	timeout?: number;
	qaOnly?: boolean;
	presenter?: PresenterName;
	pace?: Pace;
	test?: TestConfig;
}

export interface Journey {
	id: string;
	version?: number;
	title?: Text;
	description?: Text;
	route?: string;
	variants?: Record<string, string[]>;
	fixture?: string;
	mask?: TargetPath[];
	level?: Level;
	autostart?: { route: string; once?: boolean };
	steps: Step[];
}

export interface IRStep extends Step {
	do: Interaction;
	guide: Guide;
	capture?: Capture;
	timeout: number;
}

export interface IR extends Journey {
	version: number;
	route: string;
	level: Level;
	steps: IRStep[];
}

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: ValidationError[];
}

export interface CompileOptions {
	public?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: Playwright types response JSON as any.
type Json = any;

export interface FixtureRequestOptions {
	data?: unknown;
	form?: Record<string, string | number | boolean>;
	headers?: Record<string, string>;
	params?: Record<string, string | number | boolean> | string;
	method?: string;
	timeout?: number;
	failOnStatusCode?: boolean;
	ignoreHTTPSErrors?: boolean;
	maxRedirects?: number;
	maxRetries?: number;
}

export interface FixtureResponse<T = Json> {
	ok(): boolean;
	status(): number;
	statusText(): string;
	url(): string;
	headers(): Record<string, string>;
	json(): Promise<T>;
	text(): Promise<string>;
	dispose(): Promise<void>;
}

export interface FixtureRequest {
	fetch<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	get<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	head<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	post<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	put<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	patch<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
	delete<T = Json>(url: string, options?: FixtureRequestOptions): Promise<FixtureResponse<T>>;
}

export interface Fixture {
	command?: string;
	cwd?: string;
	ready?: string;
	har?: string;
	harUrl?: string;
	notFound?: 'abort' | 'fallback';
	storageState?: string;
	setup?: (ctx: {
		baseUrl: string;
		request: FixtureRequest;
	}) => Promise<Record<string, string> | undefined>;
	params?: Record<string, string>;
}

export interface TestConfig {
	retries?: number;
	workers?: number | string;
	fullyParallel?: boolean;
	timeout?: number;
	maxFailures?: number;
	forbidOnly?: boolean;
	expect?: { timeout?: number };
	use?: {
		trace?:
			| 'on'
			| 'off'
			| 'retain-on-failure'
			| 'on-first-retry'
			| 'on-all-retries'
			| 'retain-on-first-failure';
		screenshot?: 'on' | 'off' | 'only-on-failure';
		video?: 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';
		[option: string]: unknown;
	};
}

export interface Config {
	app?: {
		url: string;
		start?: string;
		cwd?: string;
		ready?: string;
		env?: Record<string, string>;
		timeout?: number;
	};
	journeys?: string | string[];
	out?: string;
	variants?: Record<string, Record<string, unknown> | string[]>;
	fixtures?: Record<string, Fixture>;
	vars?: Record<string, string>;
	pages?: Array<
		| string
		| {
				route: string;
				name?: string;
				fixture?: string;
				variants?: Record<string, string[]>;
		  }
	>;
	mask?: TargetPath[];
	storageState?: string;
	presenter?: PresenterName;
	placement?: 'anchored' | 'banner';
	video?: { size?: { width: number; height: number }; formats?: Array<'webm' | 'mp4' | 'gif'> };
	pace?: Pace;
	test?: TestConfig;
}
