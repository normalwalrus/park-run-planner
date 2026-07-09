---
name: verify
description: Drive the static app (docs/) end-to-end in a headless browser to verify UI/routing changes at their real surface.
---

# Verifying changes to the static app

The user-facing surface is the browser app in `docs/` (GitHub Pages / same app the FastAPI server mounts). Verify UI or pipeline changes by driving it headless, not by re-running the unit tests.

## Launch

```bash
python3 -m http.server -d docs 8213          # serve (run in background)
cd <scratchpad> && npm i puppeteer-core      # no browser download needed
```

Drive with puppeteer-core against the system Chrome:

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox"],
});
```

## Gotchas learned the hard way

- **Suggestion dropdown**: `closeSuggestions()` hides `#suggestions` but does NOT clear its innerHTML. Wait for `style.display === "block"` *and* `li` count > 0, or you'll read stale suggestions from the previous query.
- **Leaflet map instance** isn't exposed globally. Capture it with `page.evaluateOnNewDocument` patching `L.Map.prototype.initialize` (retry until `window.L` exists) → `window.__map`.
- **Geolocation**: `browser.createBrowserContext()` + `context.overridePermissions(BASE, ["geolocation"])` + `page.setGeolocation(...)`, then click `#locate`.
- **Real network is fine**: OneMap, Photon, Overpass, and terrain tiles are all keyless. A full non-SG plan (deep link `?country=GB&lat=51.5073&lng=-0.1657&distance=4`) completes in ~25 s; wait on `#stat-dist` changing from "–" with a generous timeout (300 s).
- Country picker state persists in `localStorage["prp:country"]` — `localStorage.clear()` between scenarios that assume the SG default.
- `/favicon.ico` 404s on the plain http.server — pre-existing noise, ignore.

## Flows worth driving

1. Fresh load → SG default (select=SG, minZoom 11, Bishan placeholder), "bishan" search shows curated spot first.
2. Switch to another country → map refits, search hits photon.komoot.io (bbox present for normal countries, absent for antimeridian ones like FJ).
3. Deep links: `?country=GB&address=…`, bare `?lat&lng` (auto-detects country), invalid `?country=ZZ` (falls back).
4. Full plan abroad: wait for `#stat-dist`, screenshot the route.
