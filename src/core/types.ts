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
		request: import('@playwright/test').APIRequestContext;
	}) => Promise<Record<string, string> | undefined>;
	params?: Record<string, string>;
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
	pages?: Array<string | { route: string; name?: string; variants?: Record<string, string[]> }>;
	mask?: TargetPath[];
	storageState?: string;
	presenter?: 'doc' | 'guide' | 'none';
	video?: { size?: { width: number; height: number }; formats?: Array<'webm' | 'mp4' | 'gif'> };
	pace?: { beforeAction?: number; afterSettle?: number };
}
