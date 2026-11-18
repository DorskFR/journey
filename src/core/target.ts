export interface TargetSegment {
	name: string;
	key?: string;
	param?: string;
	index?: number;
	/** The next segment, or a `within` scope when last, is inside this element's shadow root or frame. */
	into?: true;
}

export interface ParsedTarget {
	segments: TargetSegment[];
}

const SEGMENT = /^([A-Za-z0-9_.:-]+)((?:\[[^\]]+\])*)$/;
const BRACKET = /\[([^\]]+)\]/g;
const PARAM = /^\{([^{}]+)\}$/;
const INDEX = /^#(-?\d+)$/;
const INTO = '>>';

function splitInto(piece: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < piece.length; i += 1) {
		const ch = piece[i];
		if (ch === '[') depth += 1;
		else if (ch === ']') depth = Math.max(0, depth - 1);
		else if (depth === 0 && piece.startsWith(INTO, i)) {
			parts.push(piece.slice(start, i));
			start = i + INTO.length;
			i += INTO.length - 1;
		}
	}
	parts.push(piece.slice(start));
	return parts;
}

export function parseTarget(path: string): ParsedTarget {
	if (typeof path !== 'string' || path.trim() === '') {
		throw new Error(`Invalid target path: ${JSON.stringify(path)}`);
	}
	const fail = (raw: string): never => {
		throw new Error(`Invalid target path: ${JSON.stringify(path)} (segment "${raw}")`);
	};
	const pieces = path.split('/');
	const segments = pieces.flatMap((piece, p) => {
		const parts = splitInto(piece);
		const trailing = parts.length > 1 && parts.at(-1)?.trim() === '';
		if (trailing) {
			if (p !== pieces.length - 1) return fail(piece.trim());
			parts.pop();
		}
		return parts.map((input, i) => {
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
				if (
					segment.key !== undefined ||
					segment.param !== undefined ||
					segment.index !== undefined
				) {
					return fail(raw);
				}
				const param = PARAM.exec(text);
				if (param) segment.param = param[1] as string;
				else segment.key = text;
			}
			if (i < parts.length - 1 || trailing) segment.into = true;
			return segment;
		});
	});
	return { segments };
}

/** True when the path ends in `>>`, which only a locator's `within` may do. */
export function endsInside(target: ParsedTarget): boolean {
	return target.segments.at(-1)?.into === true;
}

export function formatTarget(target: ParsedTarget): string {
	return target.segments
		.map((s, i) => {
			let out = s.name;
			if (s.param !== undefined) out += `[{${s.param}}]`;
			else if (s.key !== undefined) out += `[${s.key}]`;
			if (s.index !== undefined) out += `[#${s.index}]`;
			const last = i === target.segments.length - 1;
			return s.into ? `${out}${INTO}` : last ? out : `${out}/`;
		})
		.join('');
}
