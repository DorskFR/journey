export interface TargetSegment {
	name: string;
	key?: string;
	param?: string;
}

export interface ParsedTarget {
	segments: TargetSegment[];
}

const SEGMENT = /^([A-Za-z0-9_.:-]+)(?:\[([^\]]+)\])?$/;

export function parseTarget(path: string): ParsedTarget {
	if (typeof path !== 'string' || path.trim() === '') {
		throw new Error(`Invalid target path: ${JSON.stringify(path)}`);
	}
	const segments = path.split('/').map((raw) => {
		const m = SEGMENT.exec(raw.trim());
		if (!m)
			throw new Error(`Invalid target path: ${JSON.stringify(path)} (segment "${raw.trim()}")`);
		const name = m[1] as string;
		const key = m[2];
		if (key === undefined) return { name };
		const p = /^\{([^{}]+)\}$/.exec(key);
		return p ? { name, param: p[1] as string } : { name, key };
	});
	return { segments };
}

export function formatTarget(target: ParsedTarget): string {
	return target.segments
		.map((s) => {
			if (s.param !== undefined) return `${s.name}[{${s.param}}]`;
			if (s.key !== undefined) return `${s.name}[${s.key}]`;
			return s.name;
		})
		.join('/');
}
