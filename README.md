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

## Watching a run

`check`, `test`, `book` and `pages` drive the browser for you, headless. When a
step fails somewhere you cannot see, `--headed` shows the window and `--slow-mo`
gives you time to read it:

```sh
npx journey book create-note --headed --slow-mo 250
```

`journey record` is headed already; `--headless` is its opt-out. A headed `book`
writes to the same files as a headless one, but window chrome and frame timing
differ — treat those captures as a debugging aid, not as docs to commit.

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
		navigate: (route) => router.goto(route),
	});
}
```

Start a guide with `window.__journey.start('create-note')` or a
`data-journey-start="create-note"` attribute on any element.

When a step names a route the user is not on, the guide offers to take them
there rather than moving on its own. `navigate` hands that over to the host
router; without it the button assigns `location.href`, which costs a document
load but resumes from the saved progress. Nothing navigates until the user
presses the button.

`register` resolves once a resumed or autostarted run has been picked up, so
`await` it before reading `window.__journey.engine()`.

### Where the guide state lives

Two things are remembered: where a run got to, and whether an `autostart.once`
journey has been seen. By default the first goes to `sessionStorage` and the
second to `localStorage`, which keeps them in one browser.

Pass a `storage` adapter to put them somewhere else — a user record on the
server, so a guide half-finished on a laptop carries on at a desk, and the
backend can decide to show it again. It may be async, and it replaces both.

```ts
mount({
	storage: {
		get: (key) => api.get(`/guide-state/${key}`),
		set: (key, value) => api.put(`/guide-state/${key}`, value),
		remove: (key) => api.delete(`/guide-state/${key}`),
	},
});
```

Bumping a journey's `version` already invalidates a stale resume and re-arms
`autostart.once`, so a guide that gained a step comes back for everyone.

### Drawing steps with the host's own components

By default a guide draws the built-in overlay: a spotlight on the target and a
card with the step text, a counter and Next/Exit buttons. Pass a `presenter` to
draw each step yourself instead, with the host's design system or a shape the
card does not fit, such as a target-less sequence of slides. The engine keeps
running autostart, progress, resume and versioning; only the rendering changes.

```ts
mount({
	presenter: {
		show(step, el, ctx) {
			tour.set({ title: ctx.title, body: ctx.body, index: ctx.index, total: ctx.total });
			tour.onNext(ctx.next);
			tour.onExit(ctx.exit);
		},
		settle() {},
		hide() {
			tour.close();
		},
	},
});
```

`show`, `settle` and `hide` are required. `show` is called once per step with the
resolved target element, or `null` when the step has none, and a context holding
the localized `title` and `body`, the step's `index` and `total`, the `action` it
performs, and `next` and `exit` callbacks. `next` is `null` when the step waits
for the user to act on the page rather than press a button. `settle` runs after
the step's expectations hold and may return a promise to delay the next step.
`hide` runs once when the run ends or is aborted.

`message`, `moveCursor` and `ripple` are optional. `message` shows a card with
no step behind it, such as the offer to navigate to another route; without it
that prompt is not drawn. `moveCursor` and `ripple` animate a pointer in preview
and doc modes; without them no pointer is drawn.

When a `presenter` is supplied the built-in overlay stays idle for the whole
run: it is not shown, moved or resized, so nothing is drawn over the host's UI.
Pass a function instead of an object to choose per mode. It is called with
`'guide'`, `'doc'`, `'spot'` or `'none'` and returns the presenter to use; a
plain object applies to every named presenter but `none`, so run mode stays
silent.

```ts
import { nonePresenter } from '@dorsk/journey/runtime';

mount({
	presenter: (name) => (name === 'guide' ? hostGuide : nonePresenter),
});
```

## What the captures show

`book` draws each step with a presenter, chosen with `--presenter` or
`presenter` in the config:

| | drawn |
| --- | --- |
| `doc` (default) | focus ring, numbered badge, caption |
| `spot` | focus ring, numbered badge |
| `guide` | a card with Next and Exit, paced for a human |
| `none` | the raw app |

```sh
npx journey book --presenter spot --video
```

`spot` is `doc` with the caption withheld — for captures that go into a page or
a video carrying its own narration, where the on-screen text would repeat it.
The journey keeps its `say` text: the manifest and the report still carry each
capture's title and body.

A single step can overrule the choice. `presenter` on a step swaps the
presenter for that step alone and restores it afterwards — `'none'` for a step
whose callout would sit on the thing it is about, `'spot'` where the caption
would repeat narration already on screen:

```ts
{ id: 'key', target: 'settings/api-key', do: { kind: 'hover' }, presenter: 'none' }
```

## How long each step is held

`pace` holds the run either side of the action: `beforeAction` after the target
is lit and before the actor touches it, `afterSettle` once the expectations pass
and the capture is taken. Set it in the config for the whole run, and on a step
to overrule it there — long enough to read a dense caption, or zero for a step
that only exists to get somewhere.

```ts
export default defineConfig({ pace: { beforeAction: 600, afterSettle: 2500 } });
```

```ts
{ id: 'summary', say: { body: 'The long one.' }, pace: { afterSettle: 5000 } }
```

Both `presenter` and `pace` on a step apply to scripted runs — `book`, the
Playwright runner, `mount` in run mode. A guided or preview run ignores them:
there the presenter is the only way a person has through the journey, so a step
may not take it away or stall them.

## Where the step text sits

By default the caption and the guide card are anchored to the target — directly
below it, or above when there is no room. That is also where an app puts its own
tooltips and menus, so on a step about a tooltip the callout lands on top of the
thing the step is about.

`placement: 'banner'` draws the text as a translucent strip across the bottom of
the viewport instead, the shape subtitles use. It is never positioned from the
target, so it cannot cover it, and it stays put from step to step.

```sh
npx journey book --placement banner
```

```ts
export default defineConfig({ placement: 'banner' });   // or mount({ placement: 'banner' })
```

The spotlight ring, the badge and the cursor stay anchored to the target either
way; only the text moves. The banner has its own tokens: `--journey-banner-surface`,
`--journey-banner-text`, `--journey-banner-padding`, `--journey-banner-align` and
`--journey-banner-inset`.

Nothing the overlay draws takes the pointer. The ring, badge, caption and card
are all transparent to hit-testing, so hovering a target still opens the app's
own tooltip and clicking it still reaches the app even where the callout covers
it. Only the guide card's buttons accept clicks.

The overlay itself sits in the top layer, above everything the page can stack.
Set `--journey-z` to take it out of the top layer and into the normal stacking
order at that z-index, so the app's own popovers can come out in front:

```css
:root { --journey-z: 5; }
```

## Theming

The overlay reads CSS custom properties, so it can be matched to the host's
palette. Set them anywhere they will inherit — usually `:root` — and they cross
the shadow boundary. Each falls back to the built-in value, so an app that sets
none keeps the default look, and one that switches themes at runtime only has to
move the variables.

```css
:root {
	--journey-accent: #ffd166;
	--journey-accent-ink: #111;
	--journey-surface: #fff;
	--journey-surface-muted: #f4f4f4;
	--journey-text: #111;
	--journey-text-muted: #555;
	--journey-text-faint: #666;
	--journey-border: #ccc;
	--journey-scrim: rgba(0, 0, 0, 0.55);
	--journey-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
	--journey-shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.25);
	--journey-radius: 8px;
	--journey-radius-sm: 6px;
	--journey-font: 14px/1.4 system-ui, sans-serif;
	/* the toast, which is deliberately inverted against the page */
	--journey-inverse-surface: #111;
	--journey-inverse-surface-raised: #333;
	--journey-inverse-text: #fff;
	--journey-inverse-border: #888;
}
```

## Existing Playwright suite

```ts
import { test, expect } from '@dorsk/journey/playwright';

test('create a note', async ({ journey }) => {
	const result = await journey.run('create-note');
	expect(result.ok).toBe(true);
});
```

Status: early. The API will move until 1.0. `SPEC.md` is the design.
