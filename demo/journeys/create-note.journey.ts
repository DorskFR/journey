import { defineJourney, param } from '@dorsk/journey';

export default defineJourney({
	id: 'create-note',
	title: 'Create a note',
	route: '/',
	variants: { viewport: ['desktop', 'mobile'] },
	level: 'checked',
	steps: [
		{
			id: 'start',
			route: '/',
			target: 'start',
			do: { kind: 'click' },
			say: { title: 'Welcome', body: 'Click Get started to open your notes.' },
			expect: [{ url: '/#notes' }, { visible: 'notes' }],
			capture: 'notes',
		},
		{
			id: 'new',
			target: 'notes/new',
			do: { kind: 'click' },
			say: { title: 'New note', body: 'Open the form to create a note.' },
			expect: [{ visible: 'dialog' }],
			capture: 'dialog',
		},
		{
			id: 'title',
			target: 'dialog/title',
			do: { kind: 'fill', value: param('var.title') },
			say: { title: 'Title', body: 'Give the note a title. Save unlocks once it has one.' },
			expect: [{ enabled: 'dialog/save' }],
		},
		{
			id: 'category',
			target: 'dialog/category',
			do: { kind: 'select', value: 'idea' },
			say: { title: 'Category', body: 'Pick a category for the note.' },
		},
		{
			id: 'save',
			target: 'dialog/save',
			do: { kind: 'click' },
			say: { title: 'Save', body: 'Save the note. It appears in the list.' },
			expect: [
				{ hidden: 'dialog' },
				{ event: 'note.saved' },
				{ count: ['notes/note', { equals: 4 }] },
				{ text: ['notes/toast', 'Saved'] },
			],
			capture: { name: 'saved', video: true },
		},
	],
});
