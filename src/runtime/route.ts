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

	const { pushState, replaceState } = history;
	const pushed: History['pushState'] = function (this: History, ...args) {
		pushState.apply(this, args);
		check();
	};
	const replaced: History['replaceState'] = function (this: History, ...args) {
		replaceState.apply(this, args);
		check();
	};
	history.pushState = pushed;
	history.replaceState = replaced;
	window.addEventListener('popstate', check);
	window.addEventListener('hashchange', check);
	return () => {
		if (history.pushState === pushed) history.pushState = pushState;
		if (history.replaceState === replaced) history.replaceState = replaceState;
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
