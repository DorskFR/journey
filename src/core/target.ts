export interface TargetSegment {
	name: string;
	key?: string;
	param?: string;
	index?: number;
}

export interface ParsedTarget {
	segments: TargetSegment[];
}

const SEGMENT = /^([A-Za-z0-9_.:-]+)((?:\[[^\]]+\])*)$/;
const BRACKET = /\[([^\]]+)\]/g;
const PARAM = /^\{([^{}]+)\}$/;
const INDEX = /^#(-?\d+)$/;

export function parseTarget(path: string): ParsedTarget {
	if (typeof path !== 'string' || path.trim() === '') {
		throw new Error(`Invalid target path: ${JSON.stringify(path)}`);
	}
	const fail = (raw: string): never => {
		throw new Error(`Invalid target path: ${JSON.stringify(path)} (segment "${raw}")`);
	};
	const segments = path.split('/').map((input) => {
		const raw = input.trim();
		const m = SEGMENT.exec(raw);
		if (!m) return fail(raw);
		const segment: TargetSegment = { name: m[1] as string };
		for (const [, body] of (m[2] as string).matchAll(BRACKET)) {
			const text = body as string;
			const index = INDEX.exec(text);
			if (text.startsWith('#')) {
				if (!index || segment.index !== undefined) return fail(raw);
				segment.index = Number(index[1]);
				continue;
			}
			if (segment.key !== undefined || segment.param !== undefined || segment.index !== undefined) {
				return fail(raw);
			}
			const param = PARAM.exec(text);
			if (param) segment.param = param[1] as string;
			else segment.key = text;
		}
		return segment;
	});
	return { segments };
}

export function formatTarget(target: ParsedTarget): string {
	return target.segments
		.map((s) => {
			let out = s.name;
			if (s.param !== undefined) out += `[{${s.param}}]`;
			else if (s.key !== undefined) out += `[${s.key}]`;
			if (s.index !== undefined) out += `[#${s.index}]`;
			return out;
		})
		.join('/');
}
