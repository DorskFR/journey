export interface Strings {
	next: string;
	exit: string;
	step: string;
	goToPage: string;
	goToPageBody: string;
	press: string;
}

export type StringsOption = Partial<Strings> | ((locale: string | undefined) => Partial<Strings>);

export type Localize = (key: keyof Strings, vars?: Record<string, string | number>) => string;

export const DEFAULT_STRINGS: Strings = {
	next: 'Next',
	exit: 'Exit',
	step: 'Step {i} of {n}',
	goToPage: 'Go to another page',
	goToPageBody: 'Open {route} to continue.',
	press: 'Press',
};

export function resolveStrings(
	option: StringsOption | undefined,
	locale: string | undefined,
): Strings {
	const partial = typeof option === 'function' ? option(locale) : option;
	return { ...DEFAULT_STRINGS, ...partial };
}

export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in vars ? String(vars[name]) : match,
	);
}

export function translator(strings: () => Strings): Localize {
	return (key, vars) => interpolate(strings()[key], vars);
}

export const defaultLocalize: Localize = translator(() => DEFAULT_STRINGS);
