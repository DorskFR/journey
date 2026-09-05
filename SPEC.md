# journey specification

This file is the contract for the implementation. Anything not stated here is
a decision to make in the simplest way that satisfies the tests. Do not add
dependencies. The browser bundles have zero dependencies. The Node side uses
only `@playwright/test` (peer) and Node built-ins.

Style: TypeScript strict, tabs, single quotes, semicolons, Biome recommended.
Imports between source files use `.js` extensions (Node ESM). No comments
that narrate what code does or how it got there; a comment is allowed only
for a non-obvious constraint (for example the popover top-layer trick).

Package name: `@dorsk/journey`. Nothing in this repository may mention any
other project, product, or company.

## 1. Concept

A journey is a list of steps. Each step names a target element, an
interaction, expectations that must hold afterwards, optional narration, and
an optional capture point. One in-page engine runs the list. Two pluggable
seats change what a run means:

| Mode    | Actor  | Presenter | Where                       |
|---------|--------|-----------|-----------------------------|
| guide   | human  | guide     | end-user browser            |
| preview | dom    | guide     | author's browser            |
| test    | driver | none      | Playwright                  |
| book    | driver | doc       | Playwright, capturing media |
| record  | human  | editor    | author's browser            |

- Actor: who performs the interaction. `human` waits for the real event on
  the target. `dom` dispatches synthetic events. `driver` hands the action to
  a host (Playwright) that performs trusted input.
- Presenter: what a human sees. `none`, `guide` (spotlight, card, Next/Exit),
  `doc` (numbered callout, no dimming, visible cursor), `editor` (panel).

## 2. Layout

```
src/
  index.ts                 public API of the "." export
  core/
    types.ts               Journey, Step, Target, Expectation, Config, IR
    define.ts              defineJourney, defineConfig, msg, param
    target.ts              parseTarget, formatTarget
    validate.ts            validate(journey) -> ValidationResult
    compile.ts             compile(journey, {public}) -> IR
    print.ts               print(ir) -> canonical .journey.ts source
  runtime/
    index.ts               mount(), window.__journey, exports engine pieces
    overlay.ts             <journey-overlay> host, shadow root, raise()
    resolve.ts             resolveOne, resolveAll, accessible name/role
    engine.ts              Engine class, step loop, events
    actors.ts              humanActor, domActor, driverActor
    presenters.ts          nonePresenter, guidePresenter, docPresenter, cursor
    progress.ts            sessionStorage persistence
    mask.ts                masking for capture
    driver.ts              window.__journey.driver protocol
  editor/
    index.ts               mountEditor(), exports
    observe.ts             event observation -> draft steps
    locate.ts              best target for an element, health
    digest.ts              UI digest and expectation suggestions
    panel.ts               editor panel UI in the overlay shadow root
    export.ts              draft -> IR -> print(); download, clipboard, POST
  playwright/
    index.ts               test fixture, runJourney, journeyTests, exports
    driver.ts              host side of the driver protocol
    fixtures.ts            apply Config fixtures (command, har, storageState, setup)
    capture.ts             screenshots, screencast, crop
    inject.ts              locate and read dist/*.iife.js for addInitScript
    journeys.config.ts     Playwright config used by `journey test`
    journeys.spec.ts       spec file used by `journey test`
  cli/
    main.ts                #!/usr/bin/env node, argv parsing, dispatch
    config.ts              loadConfig(path) via dynamic import
    load.ts                glob journeys, import, validate, compile
    app.ts                 start app command, wait for ready URL
    compile.ts             journey compile
    check.ts               journey check
    test.ts                journey test (spawns playwright test)
    record.ts              journey record <url>
    book.ts                journey book
    pages.ts               journey pages
    media.ts               ffmpeg detection, webm->mp4/gif, storyboard
    report.ts              markdown and html rendering from manifest
demo/
  serve.mjs                zero-dependency static server: node demo/serve.mjs [port]
  index.html, app.js, style.css, settings.html
  journeys/*.journey.ts    journeys used by tests and as examples
tests/
  unit/*.test.ts           run by the `unit` project, no browser
  browser/*.spec.ts        run by the `browser` project against demo/
```

Build: `tsc -p tsconfig.build.json` emits `dist/**` as ESM with types.
`scripts/bundle.mjs` produces `dist/runtime.iife.js` (global `journeyRuntime`)
and `dist/editor.iife.js` (global `journeyEditor`) with esbuild. The editor
bundle imports core (print) and runtime pieces it needs; it must work when
loaded after `runtime.iife.js` on a page, or as an ESM import in an app.

## 3. Core types

```ts
export type Locale = string;
export interface MsgRef { $msg: string }
export interface ParamRef { $param: string }   // 'fixture.x' | 'var.x' | 'variant.dim'
export type Text = string | MsgRef | Record<Locale, string>;

export type TargetPath = string;
export interface Locator {
	role?: string; name?: string; label?: string; text?: string;
	testid?: string; css?: string; within?: TargetPath; nth?: number;
}
export type Target = TargetPath | Locator;

export type Interaction =
	| { kind: 'click' } | { kind: 'dblclick' } | { kind: 'hover' } | { kind: 'none' }
	| { kind: 'fill'; value: string | ParamRef; mask?: boolean }
	| { kind: 'select'; value: string | ParamRef }
	| { kind: 'check'; checked: boolean }
	| { kind: 'press'; key: string }
	| { kind: 'navigate'; url: string };

export type Expectation =
	| { visible: Target } | { hidden: Target }
	| { text: [Target, Text] }              // textContent contains, after trim
	| { value: [Target, string | ParamRef] }
	| { checked: [Target, boolean] }
	| { enabled: Target } | { disabled: Target }
	| { url: string }                        // exact pathname, or glob with *
	| { count: [Target, { min?: number; max?: number; equals?: number }] }
	| { event: string }                      // window CustomEvent name
	| { probe: string; equals?: unknown };   // host probe by name

export interface Capture { name: string; video?: boolean; crop?: 'none' | 'target' | TargetPath }

export interface Step {
	id: string;
	route?: string;
	target?: Target;
	params?: Record<string, string | ParamRef>;
	do?: Interaction;                      // default { kind: 'none' }
	guide?: 'wait-for-user' | 'next';      // default: 'next' when do is none, else 'wait-for-user'
	say?: { title?: Text; body?: Text };
	expect?: Expectation[];
	capture?: string | Capture;
	when?: Record<string, string>;         // variant filter; step skipped if any dim differs
	optional?: boolean;                    // skip instead of fail when target is not found
	timeout?: number;                      // ms, default 10000
	qaOnly?: boolean;                      // stripped by compile({ public: true })
}

export interface Journey {
	id: string;
	version?: number;                      // default 1
	title?: Text;
	description?: Text;
	route?: string;                        // start route, default '/'
	variants?: Record<string, string[]>;   // { viewport: ['desktop','mobile'], theme: ['light'] }
	fixture?: string;
	mask?: TargetPath[];
	level?: 'smoke' | 'checked' | 'visual'; // default 'smoke'
	autostart?: { route: string; once?: boolean };
	steps: Step[];
}
```

IR is `Journey` after validation and normalization: every default filled in,
`capture` always an object, `do` always present, `guide` always present,
`version` and `level` and `route` present, `steps[i].timeout` present. IR is
plain JSON. `compile(journey, { public: true })` also removes steps with
`qaOnly` and drops `probe` expectations whose name starts with `qa.`.

`defineJourney(j)` returns `j` unchanged (typed with `const` inference).
`defineConfig(c)` returns `c`. `msg(id)` returns `{ $msg: id }`. `param(p)`
returns `{ $param: p }`.

Config. Every relative path or glob in a Config resolves against the
directory of the config file, and `app.start` and fixture `command` run with
that directory as their working directory unless `cwd` is set:

```ts
export interface Fixture {
	command?: string; cwd?: string; ready?: string;   // start a process, poll ready URL (200)
	har?: string; harUrl?: string; notFound?: 'abort' | 'fallback';
	storageState?: string;
	setup?: (ctx: { baseUrl: string; request: import('@playwright/test').APIRequestContext }) => Promise<Record<string, string> | void>;
	params?: Record<string, string>;
}
export interface Config {
	app?: { url: string; start?: string; cwd?: string; ready?: string; env?: Record<string, string>; timeout?: number };
	journeys?: string | string[];          // globs relative to config dir, default 'journeys/**/*.journey.ts'
	out?: string;                          // default 'docs/journeys'
	variants?: Record<string, Record<string, unknown> | string[]>;
	fixtures?: Record<string, Fixture>;
	vars?: Record<string, string>;
	pages?: Array<string | { route: string; name?: string; variants?: Record<string, string[]> }>;
	mask?: TargetPath[];
	storageState?: string;
	presenter?: 'doc' | 'guide' | 'none';  // book default 'doc'
	video?: { size?: { width: number; height: number }; formats?: Array<'webm' | 'mp4' | 'gif'> };
	pace?: { beforeAction?: number; afterSettle?: number };  // book only, ms, default 600 / 800
}
```

The `viewport` variant dimension is special: its values are
`{ width, height }` objects in Config and the driver applies them with
`page.setViewportSize`. Every other dimension is applied in-page through the
mount option `variants[dim](value)`; when the app registered no handler the
driver sets `document.documentElement.dataset[dim] = value` and logs a warning.
The `locale` value is also used to resolve `Record<Locale,string>` text and is
passed to the `translate` hook. Default variant when none declared:
`{ viewport: 'desktop' }` with desktop = 1280x800 and mobile = 390x844 built in.

## 4. Target paths

Grammar: `segment ( '/' segment )*`, `segment = name ( '[' key ']' )?`,
`name = [A-Za-z0-9_.:-]+`, `key = [^\]]+` where a key of the form `{p}` is a
param reference resolved from `step.params[p]`. Whitespace around `/` is
ignored. `parseTarget(path)` returns `{ segments: [{ name, key?, param? }] }`
or throws with a message that includes the offending path.

Resolution (`resolveAll(target, params, root = document)`):

- Path with one segment: all `[data-journey="name"]` under root, filtered by
  `[data-journey-key="key"]` when a key is given.
- Multiple segments: resolve the first as above, then for each subsequent
  segment search within each previously matched element. Elements matching
  a segment must not be nested inside another match of the same segment
  (take the outermost).
- Locator object: `testid` matches `[data-testid]`; `label` matches a form
  control whose associated `<label>` text or `aria-label` equals the string
  after trimming; `role` + `name` matches elements whose computed role equals
  `role` and accessible name equals `name`; `text` matches the innermost
  elements whose trimmed textContent equals the string; `css` is
  `querySelectorAll`; `within` scopes the search to a resolved path; `nth`
  picks an index after all other filters.
- Only visible elements count for targets and for `visible`, `text`, `value`,
  `checked`, `enabled`, `disabled` expectations. Visible means a non-empty
  bounding box and no ancestor with `display:none` or `visibility:hidden`.
  `hidden` passes when zero visible matches. `count` counts visible matches.

`resolveOne` returns `{ el }` for exactly one match, `{ error: 'notfound' }`
for zero, `{ error: 'ambiguous', count }` for more than one. Never guess.

Computed role: explicit `role` attribute, else implicit for `button`, `a[href]`
(link), `input` by type (`checkbox`, `radio`, `textbox`, `button` for
submit/button/reset, `searchbox`, `slider`, `spinbutton`), `select`
(combobox), `textarea` (textbox), `h1..h6` (heading), `nav`, `main`, `dialog`,
`option`, `li` (listitem), `ul`/`ol` (list), `table`, `img`, `summary`
(button), `details` (group). Accessible name: `aria-labelledby` (joined text
of referenced ids), else `aria-label`, else for form controls the associated
label's text (via `for` or wrapping), else `alt` for images, else `title`,
else trimmed textContent with whitespace collapsed. This is a pragmatic
subset, not full accname; document that in a type comment on the function.

## 5. Runtime

`mount(options)` from `@dorsk/journey/runtime`:

```ts
interface MountOptions {
	journeys?: Journey[] | (() => Promise<{ default?: Journey[] } | Journey[]>);
	editor?: boolean;                          // requires the editor bundle to be loaded
	translate?: (id: string, locale: string) => string | undefined;
	probes?: Record<string, () => unknown | Promise<unknown>>;
	variants?: Record<string, (value: string) => void | Promise<void>>;
	track?: (event: string, data: Record<string, unknown>) => void;
	exportUrl?: string;                        // editor POST target
	launcher?: boolean;                        // default false; small floating button listing journeys
}
```

`mount` is idempotent: if `window.__journey` exists it returns it. It
returns and installs `window.__journey`:

```ts
interface JourneyApi {
	list(): Array<{ id: string; title?: string; version: number }>;
	start(id: string, opts?: { mode?: 'guide' | 'preview'; from?: number; params?: Record<string, string> }): Promise<RunResult>;
	stop(): void;
	current(): { id: string; index: number } | null;
	applyVariant(dim: string, value: string): Promise<void>;
	translate(text: Text, locale?: string): string;
	driver: Driver;                            // section 7
	overlay: Overlay;
	version: string;
}
```

Also: a delegated click listener on `[data-journey-start]` calls
`start(value)`. `autostart` journeys start in guide mode when the current
pathname equals their `autostart.route`; `once` is remembered in
`localStorage['journey:done:<id>@<version>']`. On mount, if
`sessionStorage['journey:progress']` exists for a listed journey, the run
resumes at the stored index in the stored mode.

Engine (`engine.ts`): `new Engine(ir, deps)` where deps are
`{ actor, presenter, params, variant, translate, probes, pace, mask, track }`.
`run(from = 0): Promise<RunResult>` where
`RunResult = { ok: boolean; completed: number; failures: Array<{ stepId: string; error: string }> ; aborted?: boolean }`.
Per step:

1. If `when` names a dimension whose value differs from `variant`, skip.
2. Attach window listeners for every `event` expectation of this step.
3. If `route` is set and the current location does not match, ask the actor
   to navigate (`actor.navigate(route)`). For the human actor this shows a
   card asking the user to go there; for dom it assigns `location`; for the
   driver it yields `{ route }` to the host. After navigation the engine
   continues from the same step (progress is persisted before navigating).
4. Resolve the target with polling every 100 ms up to `timeout`. The human
   actor has no timeout. `optional` steps skip on timeout. Ambiguity fails
   immediately with the count in the error.
5. `presenter.show(step, el, ctx)` where ctx has index, total, resolved say
   text, and a `next()` callback for `guide: 'next'` steps.
6. Apply masks (section 5.3), wait `pace.beforeAction`, move the cursor to the
   element if the presenter has one.
7. `actor.perform(step, el)`; the engine draws the click ripple when the actor
   reports completion.
8. Wait for all expectations, polling every 100 ms up to `timeout`. A failing
   expectation produces an error string naming the expectation and the
   observed state, for example `visible notes/dialog: 0 matches`.
9. `presenter.settle(step)`, wait `pace.afterSettle`, emit `capture` (the
   driver yields it to the host), persist progress, continue.

Events emitted via a small emitter and forwarded to `track`:
`journey:start`, `step:start`, `step:resolved`, `step:acted`, `step:pass`,
`step:fail`, `step:skip`, `journey:done`, `journey:abort`.

Route matching: compare `location.pathname` to `route`; if `route` contains
`#`, compare `pathname + hash`. Exact match only.

Expectation `url`: same comparison as route; when the string contains `*`
convert to a regex where `*` is `[^/]*` and `**` is `.*`.

`text` with `MsgRef` resolves through `translate(id, locale)`; if the hook
is absent or returns undefined the id itself is used. `Record<Locale,string>`
resolves with `variant.locale`, then `document.documentElement.lang`, then
`'en'`, then the first key.

Params: `ParamRef` values resolve from `deps.params` where the bag is flat with
dotted keys, for example `{ 'fixture.noteId': '3', 'var.name': 'x', 'variant.theme': 'dark' }`.
Unresolved refs fail the step with a clear error.

### 5.1 Actors

- `humanActor`: for `click`/`dblclick` add a capturing listener for that event
  on the element and resolve when it fires there or on a descendant. For `fill`
  resolve when an `input` or `change` event fires and, if the value is a
  literal, the element value equals it. For `select` and `check` resolve on
  `change`. For `press` resolve on a matching `keydown`. For `hover` resolve
  on `pointerenter`. For `none` resolve when the presenter's Next is pressed.
- `domActor`: `click` calls `el.click()`; `dblclick` dispatches `dblclick`;
  `fill` focuses, sets the value through the native value setter of
  `HTMLInputElement`/`HTMLTextAreaElement` prototypes, then dispatches
  `input` and `change`; `select` sets `value` and dispatches `change`;
  `check` sets `checked` and dispatches `input` and `change`; `press`
  dispatches `keydown`, `keypress`, `keyup` with `key` and matching `code` on
  `el`; `hover` dispatches `pointerover`, `pointerenter`, `mouseover`,
  `mouseenter`; `navigate` assigns `location.href`.
- `driverActor`: sets `data-journey-focus="<stepId>"` on the element, yields
  `{ action }` to the host through the driver protocol, resolves when the
  host calls `driver.acted()`, then removes the attribute.

### 5.2 Presenters and overlay

`overlay.ts` creates one `<journey-overlay popover="manual">` appended to
`document.documentElement` with an open shadow root and calls
`showPopover()`. The host has `position:fixed; inset:0; width:100%;
height:100%; margin:0; padding:0; border:0; background:transparent;
overflow:visible; pointer-events:none`. Interactive children opt in with
`pointer-events:auto`. The overlay patches `HTMLDialogElement.prototype.showModal`,
`HTMLElement.prototype.showPopover` and `togglePopover` so that after each
call `overlay.raise()` runs (`hidePopover(); showPopover()`), keeping the
overlay above modal dialogs and popovers. A comment on the patch explains the
top-layer constraint. `overlay.remove()` restores the prototypes.

Overlay parts, all inside the shadow root: `spot` (spotlight, absolute box
with `box-shadow: 0 0 0 3px <accent>, 0 0 0 9999px rgba(0,0,0,.55)` for
guide; for doc only the outline and a numbered badge), `card` (title, body,
"Step i of n", buttons Next and Exit), `cursor` (SVG arrow, CSS transition
350 ms), `ripple` (expanding ring on click), `toast` (keystroke callout,
bottom right), `caption` (doc presenter text near the target), and a `panel`
slot the editor fills. Cursor and ripple are hidden for the human actor.
Positions are recomputed on `resize` and `scroll` (capture phase) while a
step is shown. Escape exits a guide run. The spotlight scrolls the target
into view (`scrollIntoView({ block: 'center' })`) before measuring.

Colors: accent `#ffd166`, text `#111`, card background `#fff`, dim
`rgba(0,0,0,.55)`. Font `system-ui`. Keep the CSS in one template string.

### 5.3 Masking

A stylesheet rule in the document head: `[data-journey-mask]{filter:blur(8px)!important}`.
In book mode (`mask: true` in deps) the engine resolves `journey.mask` plus
config masks at every step and sets `data-journey-mask` on the matches. The
attribute is removed on `journey:done` for elements the engine set it on.

### 5.4 Progress

`sessionStorage['journey:progress'] = JSON.stringify({ id, version, index, mode, params, variant, ir })`.
Written before navigation and after each step; removed on done or abort.
The driver stores `ir` too so a full reload can resume without the host
resending it.

## 6. Editor

`mountEditor(api = window.__journey)` from `@dorsk/journey/editor` renders a
panel inside the overlay `panel` slot: buttons Record/Stop, Preview, Run,
Export, and the step list. It is also what `mount({ editor: true })` calls
when the editor module is present (`window.journeyEditor` or import).

Observation (`observe.ts`): capturing listeners on `document` for `click`,
`dblclick`, `input`, `change`, `keydown`, and navigation (`popstate`,
`hashchange`, patched `history.pushState`/`replaceState`). Events whose
target is inside `<journey-overlay>` are ignored. For `input` on text
controls, buffer until `change`, `blur`, or Enter and emit one `fill` step
with the final value. A `change` on `select` emits `select`; on checkbox or
radio emits `check`. `keydown` of Enter, Escape, Tab, or arrows emits `press`
(printable keys are part of fill). Navigation emits a step with
`do: { kind: 'none' }` and `route` set, unless it happened within 500 ms after
a click, in which case `route` is attached to the following step instead.

Target choice (`locate.ts`): walk from the event target up to the nearest
element that is a button, link, input, select, textarea, `[role]`,
`[data-journey]`, `[contenteditable]`, or `[tabindex]`. If it or its
ancestors carry `data-journey`, build the path from the chain of
`data-journey` ancestors (outermost first) using `data-journey-key` values
where present, and verify with `resolveOne` that it is unique; health
`stable`. Otherwise try in order `testid`, `label`, `role`+`name`, `text`,
each verified unique with `resolveOne` (optionally scoped with `within` to
the nearest `data-journey` ancestor); health `fallback`. Otherwise a `css`
path of tag and `:nth-of-type` from the nearest id or `data-journey`
ancestor; health `fragile`.

Sensitive values: `input[type=password]`, `autocomplete` containing
`one-time-code` or `cc-`, or `name`/`id`/`autocomplete` matching
`/pass|token|secret|otp|card|cvc|ssn/i` are recorded as
`{ kind: 'fill', value: { $param: 'var.<name-or-id>' }, mask: true }`.

Digest (`digest.ts`): `digest()` returns `{ url, dialogs: string[], alerts: string[], headings: string[], counts: Record<string, number>, focused: string | null }`
where dialogs are the heading or aria-label text of open `dialog[open]` and
`[role=dialog]`, alerts are text of `[role=status]`, `[role=alert]`,
`[aria-live]`, headings are visible `h1`,`h2`,`h3` text, counts are, for each
`[data-journey]` element that has children with `data-journey-key`, the
path and the visible keyed child count. `suggest(before, after)` returns at
most three `Expectation`s in this priority: a new dialog (`visible` on its
path or `{ role: 'dialog', name }`), a url change (`url`), a count change
(`count` with `equals`), a new alert (`text` on the alert element). Each
suggestion has a human label.

Panel: step rows show index, target (with a health dot: green stable, amber
fallback, red fragile), action summary, editable `say.title` and `say.body`,
a Capture toggle, an expectation list with checkboxes for suggestions and a
remove button for accepted ones, and a delete button. Journey id and title
fields at the top. Preview runs the draft with `dom` actor and `guide`
presenter from step 0. Run runs it with `dom` actor and `none` presenter and
marks each row pass or fail. Export validates the draft, prints it, then
triggers a download `<id>.journey.ts`, copies to the clipboard when
permitted, dispatches `window` event `journey:export` with
`{ detail: { id, source, ir } }`, and POSTs `{ id, source, ir }` as JSON to
`exportUrl` when configured. Draft state persists in
`sessionStorage['journey:draft']` across reloads.

## 7. Driver protocol

`window.__journey.driver`:

```ts
interface Driver {
	load(ir: Journey, opts: { params: Record<string, string>; variant: Record<string, string>; presenter: 'none' | 'doc' | 'guide'; mask?: boolean; pace?: Pace; from?: number }): Promise<{ resumedAt: number | null }>;
	step(): Promise<
		| { done: true; result: RunResult }
		| { done: false; stepId: string; index: number; route: string }
		| { done: false; stepId: string; index: number; action: Interaction | null; marker: string | null }
	>;
	acted(): Promise<void>;
	settle(): Promise<{ ok: boolean; error?: string; capture: Capture | null; index: number; stepId: string }>;
}
```

`load` starts an engine with the `driver` actor and keeps it suspended.
`step` runs the engine until it needs the host: either a navigation (`route`)
or an action (`action`, with `marker` = `data-journey-focus` value, null for
`none`). After a `route` the host navigates and calls `load` again with the
same arguments; the engine resumes from progress and `step` continues that
same step. After an `action` the host performs it on
`[data-journey-focus="<marker>"]` and calls `acted()`, then `settle()`, which
waits for expectations and returns the capture spec. The host captures, then
calls `step()` again. Every promise rejects with a readable message when the
protocol is used out of order.

## 8. Playwright side

`inject.ts`: `runtimeSource()` and `editorSource()` read the IIFE files from
`dist` next to the compiled module (`new URL('../runtime.iife.js', import.meta.url)`).

`driver.ts`: `runJourney(page, ir, opts)` where opts are
`{ baseUrl, params, variant, presenter, mask, pace, onCapture?: (spec, ctx) => Promise<void>, applyVariant?: boolean }`.
It adds the runtime as an init script on the page's context if not already
added (track with a WeakSet), sets the viewport for the variant, navigates to
`baseUrl + ir.route`, applies non-viewport variant dims via
`applyVariant`, then loops on the protocol. Actions map to `locator.click()`,
`dblclick()`, `fill()`, `selectOption()`, `setChecked()`, `press()`, `hover()`,
`page.goto()`. Returns `RunResult`. Per-action Playwright timeout equals the
step timeout.

`fixtures.ts`: `applyFixture(name, config, ctx)` runs `command` and polls
`ready` (default `app.url`) until 200 or `timeout`, returns a stop function;
`routeFromHAR(har, { url: harUrl, notFound })` on the context; `storageState`
is passed at context creation; `setup` returns params merged under
`fixture.*`; `params` merged the same way. Config `vars` are exposed under
`var.*` and the variant under `variant.*`.

`index.ts`: `export const test = base.extend<{ journey: JourneyFixture }>()`
with `journey.run(idOrIr, opts?)` that loads config from
`process.env.JOURNEY_CONFIG` (or `journey.config.ts` in cwd) and runs one
journey in the current page with fixtures applied. `journeyTests(configPath?)`
registers, at import time, one `test` per journey and variant named
`<id> [<dim>=<value> ...]`, applying `level`: `smoke` and `checked` just run;
`visual` also compares each capture screenshot with
`expect(buffer).toMatchSnapshot(['<id>', '<variant>', '<NN>-<name>.png'])`.
`journeys.config.ts` sets `snapshotDir` to `config.out` and
`snapshotPathTemplate: '{snapshotDir}/{arg}{ext}'`, `webServer` from
`config.app` when `start` is set, `outputDir` to `<out>/.test-results`.

`capture.ts`: `captureStep(page, spec, ctx)` returns a PNG buffer of the
full viewport, or clipped to the bounding box of the target or the given path
plus 24 px padding when `crop` is set. Video: `page.screencast.start({ path })`
before the run and `stop()` after, when requested.

## 9. CLI

`journey <command> [options]`; hand-written argv parsing; `--config <path>`
defaults to `journey.config.ts` in cwd; `--help` per command; exit code 1 on
any failure; concise output, one line per journey and variant with a check
or cross.

- `compile [--public] [-o file]`: validates every journey, writes JSON array
  of IR to `-o` or prints; non-zero on validation errors listing
  `file: path: message`.
- `check`: starts the app when `app.start` is set, runs every journey and
  variant with presenter `none` at smoke level, prints a table with pass
  or fail and the number of fallback and fragile targets, exit 1 on failure.
  `--strict` also fails when any target is not `stable`.
- `test [playwright args...]`: spawns `npx playwright test -c <dist>/playwright/journeys.config.js`
  with `JOURNEY_CONFIG` set to the absolute config path, forwarding extra
  args and the exit code.
- `record <url> [-o dir] [--har] [--no-har] [--storage-state]`: launches
  headed Chromium with the runtime and editor injected and `editor: true`,
  records HAR to `<dir>/fixtures/<id>.har` (default on) and storage state to
  `<dir>/fixtures/<id>.storage.json` when the export event arrives, writes
  `<dir>/<id>.journey.ts`, prints the paths, keeps the browser open until it
  is closed. Default dir: `journeys`.
- `book [id...] [--presenter doc|guide] [--video] [--variant dim=value]`: for
  each journey and variant runs with the chosen presenter, captures every
  capture step to `<out>/<id>/<variantKey>/<NN>-<name>.png`, records
  `tour.webm` when `--video` or any capture has `video`, converts to `mp4`
  and `gif` when ffmpeg exists (formats from config, default webm and mp4),
  writes `storyboard.png`, `manifest.json`, `index.md`, `index.html`.
  `variantKey` is the dims joined with `-` in config order, for example
  `desktop-light`.
- `pages`: for each `config.pages` route and variant, navigates and captures
  the viewport to `<out>/pages/<name>/<variantKey>.png`, writes
  `<out>/pages/index.md` with a table per page.

`media.ts`: `hasFfmpeg()`; `toMp4(webm, mp4)` with
`-c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 23`; `toGif(webm, gif)`
with `fps=12,scale=800:-1:flags=lanczos` and palettegen/paletteuse;
`storyboard(pngPaths, out, page)` draws the images into a canvas in a blank
Playwright page, three per row, 400 px wide cells with a 1-based number badge,
and screenshots it. No ffmpeg for the storyboard.

`report.ts`: `manifest` is
`{ id, title, version, generatedAt, variants: Record<variantKey, { captures: Array<{ index, name, file, title, body }>, video?: Record<format, file>, storyboard: string }> }`.
`index.md` has the journey title, then per variant a heading and one figure
per capture: image, then the resolved `say.title` in bold and `say.body`.
`index.html` is the same as a fragment with `<figure>`/`<figcaption>`.
Text is resolved with the config-free fallback rules of section 5 plus the
in-page `translate` when the app registered one (ask the page).

## 10. Demo app

A small notes app that exercises every feature. No framework, no build,
served by `demo/serve.mjs` (reads files under `demo/`, correct MIME for
html, js, css, json, png, svg, ico; 404 otherwise; port from argv, default 4177).

`index.html`:

- `<nav data-journey="nav">` with links `to-home` (`/`), `to-notes` (`/#notes`),
  `to-settings` (`/settings.html`), each `data-journey="<name>"`. The prefix
  keeps the bare path `notes` unambiguous for the section below.
- Home view (hash `''`): heading "Notes demo", a "Get started" button
  `data-journey="start"` that navigates to `#notes`.
- Notes view (hash `#notes`): `<section data-journey="notes">` containing a
  toolbar with `data-journey="new"` button and a search `<input
  aria-label="Search notes" data-journey="search">`; a `<ul>` list of notes
  where each `<li data-journey="note" data-journey-key="<id>">` shows the
  title, a category badge, and buttons `data-journey="pin"` and
  `data-journey="delete"`; an empty-state paragraph `data-journey="empty"`
  when zero notes. Initial data: three notes with ids `1`,`2`,`3`. The search
  filters by title on `input`. A `<p role="status" data-journey="toast">`
  shows "Saved" for 2 s after creating a note and dispatches
  `window.dispatchEvent(new CustomEvent('note.saved', { detail: { id } }))`.
- New note `<dialog data-journey="dialog">` opened with `showModal()`: a form
  with `<label>Title <input name="title" data-journey="title"></label>`,
  `<label>Category <select name="category" data-journey="category">` with
  options `work`, `home`, `idea`, a `<label><input type="checkbox"
  name="pinned" data-journey="pinned"> Pin</label>`, buttons
  `data-journey="save"` (type submit, disabled until title is non-empty) and
  `data-journey="cancel"`. Saving appends a note with a new id, closes the
  dialog, shows the toast.
- A `<section data-journey="likes">` with six identical `<button>Like</button>`
  elements without keys, and a counter `data-journey="like-count"`.
- A `<p data-journey-mask>` containing a fake key `sk-demo-0000-1111`.
- A hidden-by-default `<div data-journey="secret" hidden>` toggled by a
  `data-journey="reveal"` button.

`settings.html`: same nav, a theme `<select aria-label="Theme"
data-journey="theme">` with `light` and `dark` that sets
`document.documentElement.dataset.theme` and persists in `localStorage`, a
`<input type="password" aria-label="API token" data-journey="token">`, and a
"Back to notes" link `data-journey="back"` to `/#notes`. Both pages load the
theme on start. Styles must make `dark` visibly different.

Everything in the demo uses plain DOM APIs. No `data-testid` anywhere except
one `data-testid="version"` span in the footer showing "demo 1.0".

`demo/journeys/create-note.journey.ts`: start route `/`, steps: step 1
`route: '/'` click `start` expect `{ url: '/#notes' }` and `{ visible: 'notes' }`, capture
`notes`; step 2 click `notes/new` expect `{ visible: 'dialog' }` with say
text, capture `dialog`; step 3 fill `dialog/title` with `param('var.title')`
expect `{ enabled: 'dialog/save' }`; step 4 select `dialog/category` `idea`;
step 5 click `dialog/save` expect `{ hidden: 'dialog' }`, `{ event: 'note.saved' }`,
`{ count: ['notes/note', { equals: 4 }] }`, `{ text: ['notes/toast', 'Saved'] }`,
capture `{ name: 'saved', video: true }`. Declare `variants: { viewport: ['desktop', 'mobile'] }`,
`level: 'checked'`, `title: 'Create a note'`, `say` on every step.

`demo/journeys/settings-theme.journey.ts`: route `/settings.html`, select
`theme` to `dark` expecting `{ probe: 'theme', equals: 'dark' }` and a `when`
free step, then click `back` expecting url `/#notes`. The demo registers
probe `theme` in its mount call. Include a `qaOnly` step that presses Escape.

`demo/journey.config.ts`: app url `http://localhost:4177`, start
`node serve.mjs 4177`, journeys `journeys/*.journey.ts`, out `out`
(gitignored as `demo/out`), variants viewport desktop and mobile and theme
light and dark, `vars: { title: 'Buy milk' }`, pages `/`, `/#notes`,
`/settings.html`.

The demo page mounts the runtime only when the query string contains
`journey` (`?journey=guide` or `?journey=edit`) by loading
`/runtime.iife.js` and `/editor.iife.js`; the static server maps those two
paths to `dist/`. The mount call registers the `theme` probe and a `theme`
variant handler.

## 11. Tests

Unit (`tests/unit`):

- `target.test.ts`: parse and format round trip, param keys, errors.
- `validate.test.ts`: valid journey passes; rejects duplicate step ids,
  function values, unknown keys, bad target syntax, unknown expectation
  shape, missing `steps`; error paths are precise.
- `compile.test.ts`: defaults filled; `public` strips `qaOnly` steps and `qa.`
  probes; IR is JSON serializable.
- `print.test.ts`: `print(compile(j))` is stable: compiling the printed
  source again (write to a temp file, dynamic import) yields deep-equal IR;
  `msg` and `param` round trip; output uses tabs and single quotes.

Browser (`tests/browser`), each spec injects `dist/runtime.iife.js` with
`addInitScript` unless it uses the demo's own `?journey=` mount:

- `resolve.spec.ts`: path resolution, keyed segments, six identical Like
  buttons are ambiguous, `nth` picks one, role and name fallback, label
  fallback, hidden elements are not visible, count.
- `engine.spec.ts`: guide mode on `create-note` with a simulated human:
  the test clicks the element that carries the spotlight (found through the
  overlay's stored target rect) and checks the card advances; Next on a
  `none` step; Escape aborts; overlay remains above a `showModal` dialog
  (temporarily set `pointer-events:auto` on the spotlight through the api and
  check `document.elementFromPoint` at the dialog's centre is the overlay
  host); progress resumes after `page.reload()`; `optional` step skips;
  failing expectation reports the observed state.
- `driver.spec.ts`: `runJourney` runs `create-note` on desktop and mobile
  with trusted input, returns ok, honours a full navigation to
  `settings.html` and back, captures are reported in order, a journey with
  a wrong expectation fails with the step id, masks are applied in book mode
  (the masked paragraph has the attribute).
- `editor.spec.ts`: mount with editor, start recording, perform the
  create-note flow with Playwright clicks and typing, stop; the draft has the
  expected steps with `stable` targets and correct actions; suggestions
  include the dialog and the count change; accept them; export produces
  source that `compile`s and, when run through `runJourney`, passes. Also
  record a click on a Like button and assert health `fragile` with a `css`
  locator, and a password fill recorded as a masked param.
- `cli.spec.ts`: run `node dist/cli/main.js compile --config demo/journey.config.ts`,
  `check`, `book create-note --variant viewport=desktop`, `pages`, using
  the demo server that the Playwright config already started (config
  `app.start` must not start a second one when the ready URL already answers),
  and assert the output files exist with the manifest structure; skip mp4
  and gif assertions when `hasFfmpeg()` is false. Run `journey test` too and
  assert exit 0.

All tests must pass with `npm test` locally and in CI on Ubuntu with
Chromium only.
