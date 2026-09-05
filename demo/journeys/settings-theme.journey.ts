import { defineJourney } from '@dorsk/journey';

export default defineJourney({
	id: 'settings-theme',
	title: 'Switch to the dark theme',
	route: '/settings.html',
	steps: [
		{
			id: 'theme',
			target: 'theme',
			do: { kind: 'select', value: 'dark' },
			say: { title: 'Theme', body: 'Choose the dark theme.' },
			expect: [{ probe: 'theme', equals: 'dark' }],
			capture: 'dark',
		},
		{
			id: 'dark-only',
			when: { theme: 'dark' },
			say: { title: 'Dark mode', body: 'This step only runs in the dark variant.' },
			expect: [{ visible: 'token' }],
		},
		{
			id: 'escape',
			target: 'token',
			do: { kind: 'press', key: 'Escape' },
			qaOnly: true,
		},
		{
			id: 'back',
			target: 'back',
			do: { kind: 'click' },
			say: { title: 'Back', body: 'Return to the notes list.' },
			expect: [{ url: '/#notes' }],
		},
	],
});
