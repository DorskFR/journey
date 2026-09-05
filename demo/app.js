const $ = (selector, root = document) => root.querySelector(selector);

function applyTheme(value) {
	document.documentElement.dataset.theme = value;
	localStorage.setItem('theme', value);
}

applyTheme(localStorage.getItem('theme') || 'light');

function setupNotes() {
	const notes = [
		{ id: 1, title: 'Plan the week', category: 'work', pinned: true },
		{ id: 2, title: 'Water the plants', category: 'home', pinned: false },
		{ id: 3, title: 'Write a short story', category: 'idea', pinned: false },
	];
	let nextId = 4;
	const list = $('#note-list');
	const search = $('[data-journey="search"]');
	const empty = $('[data-journey="empty"]');
	const toast = $('[data-journey="toast"]');
	const dialog = $('[data-journey="dialog"]');
	const form = $('#note-form');
	const title = $('[data-journey="title"]');
	const save = $('[data-journey="save"]');
	let toastTimer = 0;

	function render() {
		const query = search.value.trim().toLowerCase();
		const visible = notes.filter((n) => n.title.toLowerCase().includes(query));
		list.replaceChildren(
			...visible.map((note) => {
				const li = document.createElement('li');
				li.dataset.journey = 'note';
				li.dataset.journeyKey = String(note.id);
				li.dataset.pinned = String(note.pinned);
				const span = document.createElement('span');
				span.className = 'title';
				span.textContent = note.title;
				const badge = document.createElement('span');
				badge.className = 'badge';
				badge.textContent = note.category;
				const pin = document.createElement('button');
				pin.type = 'button';
				pin.dataset.journey = 'pin';
				pin.textContent = note.pinned ? 'Unpin' : 'Pin';
				pin.setAttribute('aria-pressed', String(note.pinned));
				pin.addEventListener('click', () => {
					note.pinned = !note.pinned;
					render();
				});
				const del = document.createElement('button');
				del.type = 'button';
				del.dataset.journey = 'delete';
				del.textContent = 'Delete';
				del.setAttribute('aria-label', `Delete ${note.title}`);
				del.addEventListener('click', () => {
					notes.splice(notes.indexOf(note), 1);
					render();
				});
				li.append(span, badge, pin, del);
				return li;
			}),
		);
		empty.hidden = notes.length > 0;
	}

	function showToast(text) {
		toast.textContent = text;
		toast.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.hidden = true;
		}, 2000);
	}

	search.addEventListener('input', render);
	$('[data-journey="new"]').addEventListener('click', () => {
		form.reset();
		save.disabled = true;
		dialog.showModal();
	});
	title.addEventListener('input', () => {
		save.disabled = title.value.trim() === '';
	});
	$('[data-journey="cancel"]').addEventListener('click', () => dialog.close());
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const data = new FormData(form);
		const id = nextId++;
		notes.push({
			id,
			title: String(data.get('title')).trim(),
			category: String(data.get('category')),
			pinned: data.get('pinned') === 'on',
		});
		dialog.close();
		render();
		showToast('Saved');
		window.dispatchEvent(new CustomEvent('note.saved', { detail: { id } }));
	});
	render();
}

function setupViews() {
	const views = document.querySelectorAll('[data-view]');
	function show() {
		const current = location.hash.replace(/^#/, '');
		for (const view of views) view.hidden = view.dataset.view !== current;
	}
	window.addEventListener('hashchange', show);
	show();
	$('[data-journey="start"]').addEventListener('click', () => {
		location.hash = 'notes';
	});
}

function setupLikes() {
	const count = $('[data-journey="like-count"]');
	let likes = 0;
	for (const button of document.querySelectorAll('[data-journey="likes"] button')) {
		button.addEventListener('click', () => {
			likes += 1;
			count.textContent = String(likes);
		});
	}
}

function setupSecret() {
	const reveal = $('[data-journey="reveal"]');
	const secret = $('[data-journey="secret"]');
	reveal.addEventListener('click', () => {
		secret.hidden = !secret.hidden;
		reveal.setAttribute('aria-expanded', String(!secret.hidden));
		reveal.textContent = secret.hidden ? 'Reveal' : 'Hide';
	});
}

function setupSettings() {
	const theme = $('[data-journey="theme"]');
	theme.value = document.documentElement.dataset.theme;
	theme.addEventListener('change', () => applyTheme(theme.value));
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		script.onload = resolve;
		script.onerror = () => reject(new Error(`failed to load ${src}`));
		document.head.append(script);
	});
}

async function mountJourney() {
	const value = new URLSearchParams(location.search).get('journey');
	if (value === null) return;
	await loadScript('/runtime.iife.js').catch(() => {});
	if (value === 'edit') await loadScript('/editor.iife.js').catch(() => {});
	if (typeof journeyRuntime === 'undefined') return;
	journeyRuntime.mount({
		editor: value === 'edit',
		probes: { theme: () => document.documentElement.dataset.theme },
		variants: { theme: (v) => applyTheme(v) },
	});
	if (value === 'edit' && typeof journeyEditor !== 'undefined') journeyEditor.mountEditor();
}

if ($('#app')) {
	setupViews();
	setupNotes();
	setupLikes();
	setupSecret();
}
if ($('#settings')) setupSettings();
mountJourney();
