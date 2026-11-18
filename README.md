# journey

Record a user journey once. Replay it as a QA test, an in-app guided tour,
or screenshots and video that keep your docs in sync.

```sh
npm i -D @dorsk/journey @playwright/test
```

`@playwright/test` is an optional peer: an app that only ships the guide or
the editor installs `@dorsk/journey` alone (see [In the app](#in-the-app)).

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

`notes/note[42]/delete` is that button. When any one of the repeated
elements will do, index instead of keying: `notes/note[#0]/delete` is the
first visible note's button, `note[#-1]` the last. That keeps a journey
user-agnostic — it clicks through to whatever the reader actually has,
instead of naming an entity only your fixtures contain — and an indexed path
is still a path, so `journey check --strict` accepts it.

Without attributes the recorder falls back to accessible role and name,
labels, test ids and text, and `journey check --strict` tells you which
targets still need one.

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

Paths are relative to the config file. Every command loads the config and
the journeys with Playwright's TypeScript loader, the same one `journey test`
uses, so extensionless imports, enums, `tsconfig` paths and packages without
`"type": "module"` work everywhere. Without `@playwright/test`, `compile`
falls back to Node type stripping: relative imports need their `.ts`
extension, and enums, namespaces, parameter properties and `tsconfig` paths
are not supported.

`journey record` also saves a HAR to
`journeys/fixtures/<id>.har` so the journey replays offline (`--no-har` to
skip). Auth and cookie headers and request bodies with a secret field are
removed, but response bodies stay: review the HAR before committing it.
`--storage-state` also saves cookies and local storage to
`.journey/<id>.storage.json`, a self-gitignored directory outside the
journeys; it holds live session tokens, so never commit it.

`check`, `book` and `pages` start `app.start` when `app.url` does not answer,
and stop it on every exit, Ctrl-C included. When it never answers, the error
ends with the last 40 lines it printed.

A driven run (`check`, `test`, `book`) opens the app with `?journey=run` and
keeps that flag on every page it loads, links and reloads included, so an app
that mounts its probes and variant handlers only under `?journey=` keeps them
after a full navigation. The run's variants are applied again after every
load, so a journey that changes a varied setting itself (the theme of a
`theme` variant) sees it reset on the next full navigation. A `viewport`
value needs a size: one that is not `desktop`, `mobile` or declared in
`variants.viewport` fails the run. `storageState` seeds cookies and local
storage once, at the start; what the journey stores afterwards survives
later loads.

`book --variant dim=value` books only the matching variants; repeating a dim
matches any of its values (`--variant viewport=desktop --variant
viewport=mobile`), and an unknown dim or value exits 1 with the valid ones.
The journey's `manifest.json` and index keep the variants already booked on
disk.

`pages` names each route's directory after its path, query and hash in
lowercase letters, digits and `-`: `/` is `home`, `/users/1/edit` is
`users-1-edit`, `/?tab=2` is `tab-2`. Two routes with one name (`/notes` and
`/#notes`) fail: give one a `name`.

Journey ids, step ids, capture names and variant values become file names, so
they must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (`create-note`, `step_2.a`).

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

Only needed for guide mode or the in-app editor. The runtime and the editor
have no dependencies and do not need `@playwright/test`. Both import cleanly
in Node (SSR, prerender, unit tests); `mount` and `mountEditor` must run in
the browser.

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

An `autostart` journey starts when the location matches its `autostart.route`,
which takes the same forms as a `url` expectation (`/dashboard`, `/#notes`,
`/items/*`). It is checked at `register` and after every client-side
navigation (`pushState`, `replaceState`, back and forward, hash changes), so
an SPA needs no extra wiring.

`when: { viewport }` steps follow the screen the guide starts on: below 768px
wide it runs as `mobile`, otherwise `desktop`, and `locale` comes from
`<html lang>`. Name your own values with `mount({ variant })`, an object or a
function read at each start:

```ts
mount({ variant: () => ({ viewport: innerWidth < 1024 ? 'tablet' : 'desktop', theme: currentTheme() }) });
```

### Params in the app

A guide asks the user for its `fill` and `select` params: the step accepts
whatever they type or pick, and later steps that read the same param get that
value. Every other param (a target key, a step param, a param an expectation
reads before any step asked for it) has to be supplied. Give them to every
in-app start (`data-journey-start`, the launcher, autostart, a resumed run)
with `mount({ params })`, an object or a function of the journey id:

```ts
mount({ params: (id) => ({ 'fixture.noteId': currentNote() }) });
```

`start(id, { params })` overrides them for one run. A run that lacks a param
it cannot ask for does not start: `start` resolves with
`{ ok: false, failures: [{ stepId, error: 'missing param "…"' }] }` and logs
it to the console. Preview and run mode ask for nothing, so every param they
read must be supplied.

### Registering, re-mounting and unmounting

`register` validates each journey on its own. An invalid one is skipped with a
`console.error`, drops any journey registered earlier under its id, and the
rest are registered; it resolves with `{ registered: string[], rejected:
Array<{ index, id?, error }> }`.

Calling `mount` again applies the new options to the mounted runtime and
returns the same api; `mount()` with no options just returns it.
`window.__journey.unmount()` stops the run and removes the click listener,
the overlay, the launcher and `window.__journey`, so the next `mount` starts
fresh, for example after a user switch with a per-user `storage` adapter.

When a step names a route the user is not on, the guide offers to take them
there rather than moving on its own. `navigate` hands that over to the host
router; without it the button assigns `location.href`, which costs a document
load but resumes from the saved progress. Nothing navigates until the user
presses the button.

While a step's target is not on the page, its card is drawn without a
spotlight, with Exit. If the target does not appear within the step's
`timeout` (10 s by default), an `optional` step is skipped and any other step
ends the guide as failed, so it is not resumed on the next load. A target the
page re-renders is found again.

Escape exits the guide, unless the page handled it first (`preventDefault()`),
focus is in an open dialog, popover, menu or listbox or on an expanded
control, or the step itself asks the user to press Escape.

`register` resolves once a resumed or autostarted run has been picked up, so
`await` it before reading `window.__journey.engine()`.

### Where the guide state lives

Two things are remembered: where a run got to, and whether an `autostart.once`
journey has been seen. It counts as seen once it completes or the user exits
it; a run that fails is offered again on the next load. By default the first goes to `sessionStorage` and the
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

The adapter receives the run's position, mode, variant and non-secret
params. Params under `var.`, params whose name looks sensitive (`pass`,
`token`, `secret`, `otp`, `card`, `cvc`, `ssn`) and the params of `mask: true`
fills are never stored. To resume a run that needs them, pass them again with `mount({ params })`,
or `register(journeys, { params })` for that resume only. A fill param the
user is asked for is asked again; any other missing param ends the resumed
run before it draws anything.

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

`show`, `settle` and `hide` are required. `show` is called for each step with the
resolved target element, or `null` when the step has none; in guide and
preview runs it is first called with `null` while the target is pending, and in
guide runs again when the page replaces the target. Its context holds
the localized `title` and `body`, the step's `index` and `total`, the `action` it
performs, and `next` and `exit` callbacks. `next` is `null` when the step waits
for the user to act on the page rather than press a button. `settle` runs after
the step's expectations hold and may return a promise to delay the next step;
one still pending at the step's `timeout` fails the step, and so does a
pending `moveCursor`.
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

`book` writes to `<out>/book/<id>/<variant>/`, apart from the `level: 'visual'`
baselines `journey test` keeps under `<out>/<id>/`, and draws each step with a
presenter, chosen with `--presenter` or `presenter` in the config:

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

### Secrets in captures

`mask` on a journey or in the config lists targets `book` blurs. A `mask: true`
fill, which `journey record` writes for passwords and secret-looking fields,
blurs its field before the value is typed, in `book` and in `journey test`
visual snapshots alike. Masks follow the page: what a step reveals or
re-renders is blurred before it is ever drawn, in screenshots and in the video.
The value still reaches the field, and Playwright traces still carry it.

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

## In CI

`journey test` runs one Playwright test per journey and variant, spread
across workers. Every argument other than `--config`, `--headed` and
`--slow-mo` goes to `playwright test` as written:

```sh
npx journey test --shard 1/4 --workers 4 --grep create-note --reporter dot
```

A failed test keeps its trace and screenshot in `<out>/.test-results/`, and
an html report is written to `<out>/.test-report/`. Under `CI` a failure is
retried once. Flags such as `--workers`, `--retries`, `--trace` and
`--reporter` override these defaults.

## Existing Playwright suite

```ts
import { test, expect } from '@dorsk/journey/playwright';

test('create a note', async ({ journey }) => {
	const result = await journey.run('create-note');
	expect(result.ok).toBe(true);
});
```

Status: early. The API will move until 1.0. `SPEC.md` is the design.
