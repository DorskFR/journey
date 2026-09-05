# journey

Record a user journey once. Replay it as a QA test, an in-app guided tour,
or screenshots and video that keep your docs in sync.

```sh
npm i -D @dorsk/journey
```

One declarative `.journey.ts` file per flow. One in-page engine that runs it
in four ways: a human performs the steps with a spotlight (guide), Playwright
performs them with assertions (test), Playwright performs them slowly with
callouts while recording (book), or a person clicks through the app and the
editor writes the file (record).

```sh
npx journey record http://localhost:5173   # click through the app, get a .journey.ts
npx journey test                            # replay every journey as a Playwright test
npx journey book                            # screenshots, video and markdown per journey
```

Elements are addressed by scoped `data-journey` paths, with accessible role
and name as the fallback, so it works on any rendered HTML regardless of
framework. The browser runtime has no dependencies. The Node side is a thin
layer over Playwright.

Status: early. The API will move until 1.0. See `SPEC.md` for the design.
