import type { Config, Journey, MsgRef, ParamRef } from './types.js';

export function defineJourney<const J extends Journey>(journey: J): J {
	return journey;
}

export function defineConfig<const C extends Config>(config: C): C {
	return config;
}

export function msg(id: string): MsgRef {
	return { $msg: id };
}

export function param(p: string): ParamRef {
	return { $param: p };
}
