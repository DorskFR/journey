const HISTORY_HOOK = Symbol.for('journey.history');

interface HistoryHook {
	listeners: Set<() => void>;
	unwrap(): void;
}

type HookedWindow = Window & { [HISTORY_HOOK]?: HistoryHook };

function installHook(w: HookedWindow): HistoryHook {
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch (error) {
				reportError(error);
			}
		}
	};
	const { pushState, replaceState } = history;
	const pushed: History['pushState'] = function (this: History, ...args) {
		pushState.apply(this, args);
		notify();
	};
	const replaced: History['replaceState'] = function (this: History, ...args) {
		replaceState.apply(this, args);
		notify();
	};
	history.pushState = pushed;
	history.replaceState = replaced;
	const hook: HistoryHook = {
		listeners,
		unwrap() {
			if (history.pushState !== pushed || history.replaceState !== replaced) return;
			history.pushState = pushState;
			history.replaceState = replaceState;
			if (w[HISTORY_HOOK] === hook) delete w[HISTORY_HOOK];
		},
	};
	w[HISTORY_HOOK] = hook;
	return hook;
}

/**
 * Calls `listener` after every history.pushState / replaceState. One wrapper is
 * shared per window by every subscriber, including other bundles, so one
 * unsubscribing never unwraps another.
 */
export function onHistoryChange(listener: () => void): () => void {
	const w = window as HookedWindow;
	const hook = w[HISTORY_HOOK] ?? installHook(w);
	hook.listeners.add(listener);
	return () => {
		hook.listeners.delete(listener);
		if (hook.listeners.size === 0) hook.unwrap();
	};
}

export function watchRoute(onChange: () => void): () => void {
	let last = location.href;
	let queued = false;
	const check = (): void => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (location.href === last) return;
			last = location.href;
			onChange();
		});
	};

	const navigation = (window as { navigation?: EventTarget }).navigation;
	if (navigation && typeof navigation.addEventListener === 'function') {
		navigation.addEventListener('currententrychange', check);
		return () => navigation.removeEventListener('currententrychange', check);
	}

	const unhook = onHistoryChange(check);
	window.addEventListener('popstate', check);
	window.addEventListener('hashchange', check);
	return () => {
		unhook();
		window.removeEventListener('popstate', check);
		window.removeEventListener('hashchange', check);
	};
}

export const MOBILE_QUERY = '(max-width: 767px)';

export function detectVariant(): Record<string, string> {
	const variant: Record<string, string> = {
		viewport: window.matchMedia?.(MOBILE_QUERY).matches ? 'mobile' : 'desktop',
	};
	const lang = document.documentElement.lang;
	if (lang) variant.locale = lang;
	return variant;
}
