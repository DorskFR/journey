# journey

Record a user journey once. Replay it as a QA test, an in-app guided tour,
or screenshots and video that keep your docs in sync.

```sh
npm i -D @dorsk/journey @playwright/test
```

One declarative `.journey.ts` file per flow. One in-page engine that runs it
four ways:

| Mode   | Who acts   | What shows            | Where                  |
|--------|------------|-----------------------|------------------------|
| guide  | the user   | spotlight and card    | your app, behind a flag|
| test   | Playwright | nothing               | CI                     |
| book   | Playwright | numbered callouts     | CI, writing docs       |
| record | the author | the editor panel      | any URL, no app change |

```sh
npx journey record http://localhost:5173    # click through the app, get a .journey.ts
npx journey check                           # every journey resolves and runs
npx journey test                            # journeys as Playwright tests
npx journey book                            # screenshots, video, storyboard, markdown
npx journey pages                           # a screenshot per route and variant
```

## A journey

```ts
import { defineJourney, param } from '@dorsk/journey';

export default defineJourney({
	id: 'create-note',
	title: 'Create a note',
	route: '/',
	variants: { viewport: ['desktop', 'mobile'] },
	steps: [
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
			expect: [{ enabled: 'dialog/save' }],
		},
		{
			id: 'save',
			target: 'dialog/save',
			do: { kind: 'click' },
			expect: [{ hidden: 'dialog' }, { count: ['notes/note', { equals: 4 }] }],
			capture: { name: 'saved', video: true },
		},
	],
});
```

Targets are scoped `data-journey` paths. Repeated elements carry a key:

```html
<section data-journey="notes">
  <li data-journey="note" data-journey-key="42">
    <button data-journey="delete">Delete</button>
```

`notes/note[42]/delete` is that button. Without attributes the recorder
falls back to accessible role and name, labels, test ids and text, and
`journey check --strict` tells you which targets still need one.

## Config

```ts
// journey.config.ts
import { defineConfig } from '@dorsk/journey';

export default defineConfig({
	app: { url: 'http://localhost:5173', start: 'npm run dev' },
	journeys: 'journeys/*.journey.ts',
	out: 'docs/journeys',
	variants: {
		viewport: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } },
		theme: ['light', 'dark'],
	},
	vars: { title: 'Buy milk' },
	fixtures: { seeded: { har: 'journeys/fixtures/seeded.har' } },
	pages: ['/', '/settings'],
});
```

Paths are relative to the config file. `journey record` also saves a HAR and
the storage state next to the journey, so it replays offline.

## In the app

Only needed for guide mode or the in-app editor. The runtime has no
dependencies.

```ts
if (import.meta.env.PUBLIC_JOURNEY) {
	const { mount } = await import('@dorsk/journey/runtime');
	mount({
		journeys: () => import('./journeys'),
		editor: import.meta.env.PUBLIC_JOURNEY === 'edit',
		translate: (id, locale) => t(id, locale),
		variants: { theme: (v) => setTheme(v) },
	});
}
```

Start a guide with `window.__journey.start('create-note')` or a
`data-journey-start="create-note"` attribute on any element.

## Existing Playwright suite

```ts
import { test, expect } from '@dorsk/journey/playwright';

test('create a note', async ({ journey }) => {
	const result = await journey.run('create-note');
	expect(result.ok).toBe(true);
});
```

Status: early. The API will move until 1.0. `SPEC.md` is the design.
