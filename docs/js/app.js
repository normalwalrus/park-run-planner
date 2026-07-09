// UI wiring: run the whole planning pipeline in the browser.

import { geocode, search, mergeSuggestions } from "./geocode.js";
import { SG_BOUNDS, inBounds } from "./geo.js";
import { COUNTRIES, countryByCode, detectCountry } from "./countries.js";
import { loadGraph, isGraphCached } from "./overpass.js";
import { planRoute, NoRouteError } from "./loop.js";
import { googleMapsUrl } from "./maps.js";

const SG_CENTER = [1.3521, 103.8198];
const MIN_QUERY_CHARS = 3;
const DEBOUNCE_MS = 250;
const COUNTRY_STORE = "prp:country";

// Popular running spots (Singapore only), ranked first in the dropdown when
// they match. Other countries rely purely on the geocoder.
const SPOTS = [
  { name: "Bishan-Ang Mo Kio Park", lat: 1.3614, lng: 103.8455 },
  { name: "East Coast Park", lat: 1.3008, lng: 103.9122 },
  { name: "MacRitchie Reservoir", lat: 1.3444, lng: 103.8365 },
  { name: "Singapore Botanic Gardens", lat: 1.3138, lng: 103.8159 },
  { name: "Gardens by the Bay", lat: 1.2816, lng: 103.8636 },
  { name: "Punggol Waterway Park", lat: 1.4113, lng: 103.9058 },
  { name: "Jurong Lake Gardens", lat: 1.3404, lng: 103.7266 },
  { name: "Bedok Reservoir Park", lat: 1.3423, lng: 103.9327 },
  { name: "West Coast Park", lat: 1.2926, lng: 103.7651 },
];

let coords = null;
let routeLayer = null;
const MAX_CACHED_ROUTES = 3;
// One planning session per "Plan my run" press: routes generated for the same
// start/distance/shape, of which the newest MAX_CACHED_ROUTES stay switchable.
let session = null; // {start, distanceKm, shape, avoid, routes: [{id, route}], counter, activeId}
const $ = (id) => document.getElementById(id);

// Map is shown from the start; the view (and, for Singapore, the historical
// lock on the island) follows the selected country — see applyCountry below.
const [south, west, north, east] = SG_BOUNDS;
const SG_MAX_BOUNDS = [
  [south - 0.02, west - 0.02],
  [north + 0.02, east + 0.02],
];
const map = L.map("map", { maxBoundsViscosity: 1.0 });
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// ---- Status card / progress -------------------------------------------------

const card = $("status-card");
let tickTimer = null;
let startedAt = 0;
let estimateS = 0;

function showStatus(message, kind = "info") {
  stopTicker();
  card.hidden = false;
  card.className = kind === "error" ? "error" : kind === "done" ? "done" : "";
  $("status-text").textContent = message;
  $("status-time").textContent = "";
  $("bar").hidden = true;
  $("retry").hidden = true;
}

function startProgress(message, seconds) {
  card.hidden = false;
  card.className = "";
  $("status-text").textContent = message;
  $("bar").hidden = false;
  $("retry").hidden = true;
  startedAt = performance.now();
  estimateS = seconds;
  stopTicker();
  tickTimer = setInterval(tick, 100);
  tick();
}

function setStage(message) {
  $("status-text").textContent = message;
}

function elapsedSeconds() {
  return (performance.now() - startedAt) / 1000;
}

function setTrailProgress(pct) {
  $("bar-fill").style.width = `${pct}%`;
  $("bar-runner").style.left = `calc(${pct}% - 0.55rem)`;
}

function tick() {
  const elapsed = elapsedSeconds();
  const overrun = elapsed > estimateS;
  card.classList.toggle("overrun", overrun);
  // Half again past the estimate usually means a stalled download: offer a retry.
  $("retry").hidden = elapsed <= estimateS * 1.5;
  setTrailProgress(Math.min((elapsed / estimateS) * 100, 97));
  $("status-time").textContent = overrun
    ? `${elapsed.toFixed(1)} s — taking longer than expected`
    : `${elapsed.toFixed(1)} s elapsed · ~${Math.round(estimateS)} s expected`;
}

function endProgress(kind, message) {
  const elapsed = elapsedSeconds();
  stopTicker();
  card.className = kind;
  $("status-text").textContent = message;
  $("retry").hidden = true;
  if (kind === "done") {
    setTrailProgress(100);
    $("status-time").textContent = `done in ${elapsed.toFixed(1)} s`;
  } else {
    $("bar").hidden = true;
    $("status-time").textContent = "";
  }
}

function stopTicker() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// ---- Type-ahead suggestions -------------------------------------------------

let suggestions = [];
let activeIndex = -1;
let debounceTimer = null;
let searchSeq = 0;

const input = $("address");
const listEl = $("suggestions");

function updateClearButton() {
  $("clear").hidden = input.value.length === 0;
}

$("clear").addEventListener("click", () => {
  input.value = "";
  coords = null;
  closeSuggestions();
  updateClearButton();
  card.hidden = true;
  input.focus();
});

input.addEventListener("input", () => {
  coords = null;
  updateClearButton();
  clearTimeout(debounceTimer);
  const query = input.value.trim();
  if (query.length < MIN_QUERY_CHARS) return closeSuggestions();
  debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
});

async function runSearch(query) {
  const seq = ++searchSeq;
  let results = [];
  try {
    results = await search(query, country);
  } catch {
    results = []; // suggestion failures are silent; curated spots may still match
  }
  if (seq !== searchSeq || input.value.trim() !== query) return; // stale response
  suggestions = mergeSuggestions(country.code === "SG" ? SPOTS : [], results, query);
  activeIndex = -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!suggestions.length) return closeSuggestions();
  listEl.innerHTML = suggestions
    .map(
      (s, i) => `
      <li role="option" aria-selected="${i === activeIndex}" data-i="${i}"
          class="${i === activeIndex ? "active" : ""}">
        <b>${s.name}</b>${s.address && s.address !== s.name ? `<small>${s.address}</small>` : ""}
      </li>`
    )
    .join("");
  listEl.style.display = "block";
  input.setAttribute("aria-expanded", "true");
}

function closeSuggestions() {
  suggestions = [];
  activeIndex = -1;
  listEl.style.display = "none";
  input.setAttribute("aria-expanded", "false");
}

// Picking only sets the start point — "Plan my run" starts the planning.
function pickSuggestion(index) {
  const s = suggestions[index];
  if (!s) return;
  coords = { lat: s.lat, lng: s.lng };
  input.value = s.name;
  updateClearButton();
  closeSuggestions();
  showStatus(`Start point set: ${s.name}. Press “Plan my run” to plan your route.`);
}

// mousedown (not click) so selection beats the input's blur.
listEl.addEventListener("mousedown", (event) => {
  const item = event.target.closest("li[data-i]");
  if (item) {
    event.preventDefault();
    pickSuggestion(Number(item.dataset.i));
  }
});

input.addEventListener("keydown", (event) => {
  if (!suggestions.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeIndex = (activeIndex + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "Enter" && activeIndex >= 0) {
    event.preventDefault();
    pickSuggestion(activeIndex);
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});

input.addEventListener("blur", () => setTimeout(closeSuggestions, 150));

// ---- Country selection --------------------------------------------------------

const countrySelect = $("country");
countrySelect.innerHTML = COUNTRIES.map(
  (c) => `<option value="${c.code}">${c.name}</option>`
).join("");

function storedCountry() {
  try {
    return localStorage.getItem(COUNTRY_STORE);
  } catch {
    return null;
  }
}

const params = new URLSearchParams(location.search);
let country =
  countryByCode(params.get("country")) ?? countryByCode(storedCountry()) ?? countryByCode("SG");

function applyCountry(entry) {
  country = entry;
  try {
    localStorage.setItem(COUNTRY_STORE, entry.code);
  } catch {
    // private mode — the choice just won't persist
  }
  countrySelect.value = entry.code;
  input.placeholder = entry.code === "SG" ? "e.g. Bishan Park or 560406" : "e.g. Hyde Park";
  if (entry.code === "SG") {
    // The historical island lock: keeps the SG experience exactly as before.
    map.setMinZoom(11);
    map.setMaxBounds(SG_MAX_BOUNDS);
    map.setView(SG_CENTER, 12);
  } else {
    map.setMaxBounds(null);
    map.setMinZoom(3);
    const [s, w, n, e] = entry.bbox;
    // OSM tiles wrap horizontally, so an east edge past 180° renders fine.
    map.fitBounds([
      [s, w],
      [n, e + (w > e ? 360 : 0)],
    ]);
  }
}

applyCountry(country);

countrySelect.addEventListener("change", () => {
  const entry = countryByCode(countrySelect.value);
  if (!entry || entry.code === country.code) return;
  applyCountry(entry);
  coords = null;
  input.value = "";
  updateClearButton();
  closeSuggestions();
  card.hidden = true;
});

// ---- Location + planning ----------------------------------------------------

$("locate").addEventListener("click", () => {
  showStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const found = detectCountry(here.lat, here.lng);
      if (!found) {
        return showStatus(
          "Could not match your location to a country — search for a place instead.",
          "error"
        );
      }
      if (found.code !== country.code) applyCountry(found);
      coords = here;
      input.value = "";
      updateClearButton();
      showStatus(
        `Start point set: your location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}). ` +
          "Press “Plan my run” to plan your route."
      );
    },
    () => showStatus("Could not get your location — search for a place instead.", "error")
  );
});

function selectedShape() {
  return document.querySelector('input[name="shape"]:checked')?.value ?? "loop";
}

function selectedElevation() {
  return document.querySelector('input[name="elev"]:checked')?.value ?? "low";
}

function selectedStay() {
  return document.querySelector('input[name="stay"]:checked')?.value === "yes";
}

function selectedSights() {
  return document.querySelector('input[name="sights"]:checked')?.value === "yes";
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  closeSuggestions();
  const distanceKm = parseFloat($("distance").value);
  if (!(distanceKm >= 1 && distanceKm <= 30)) {
    return showStatus("Distance must be between 1 and 30 km.", "error");
  }
  if (!coords) {
    if (input.value.trim()) {
      showStatus("Pick a suggestion from the dropdown to choose your start point.", "error");
      runSearch(input.value.trim());
    } else {
      showStatus("Search for a place, or use your location.", "error");
    }
    return;
  }
  if (!inBounds(coords.lat, coords.lng, country.bbox)) {
    return showStatus(
      `That start point is outside ${country.name} — pick a place there or switch country.`,
      "error"
    );
  }
  session = {
    start: coords,
    distanceKm,
    shape: selectedShape(),
    elev: selectedElevation(),
    stay: selectedStay(),
    sights: selectedSights(),
    avoid: new Set(),
    routes: [],
    counter: 0,
    activeId: null,
  };
  await runPlan(false);
});

function estimateSeconds(start, graphDistanceM, distanceKm) {
  // Cached covers the persistent cache too: no download, but the graph still
  // gets rebuilt and elevation-annotated.
  const download = isGraphCached(start.lat, start.lng, graphDistanceM) ? 2 : 15;
  const searchTime = 1 + distanceKm * 0.4; // turn-aware route search grows with area
  return download + searchTime;
}

// Each attempt gets a sequence number; the retry button starts a fresh attempt
// and the superseded one (usually a stalled download) exits without touching
// the UI or the session when it eventually resolves.
let planSeq = 0;
let planAlternate = false;

async function runPlan(alternate) {
  const seq = ++planSeq;
  planAlternate = alternate;
  $("plan").disabled = $("alt").disabled = true;
  const { start, distanceKm, shape } = session;
  // A one-way route ranges up to the full distance from the start, a loop ~half.
  const graphDistanceM = shape === "straight" ? distanceKm * 2000 : distanceKm * 1000;
  startProgress(
    "Downloading map data for this area…",
    estimateSeconds(start, graphDistanceM, distanceKm)
  );
  try {
    const graph = await loadGraph(start.lat, start.lng, graphDistanceM);
    if (seq !== planSeq) return; // superseded by a retry
    setStage(alternate ? "Searching for an alternate route…" : "Searching for the greenest route…");
    await new Promise((r) => setTimeout(r)); // let the status paint before the search blocks
    if (seq !== planSeq) return;
    const route = planRoute(
      graph, start.lat, start.lng, distanceKm * 1000, session.avoid, shape,
      session.elev, session.stay, session.sights
    );
    for (const pair of route.pairs) session.avoid.add(pair); // future alternates steer away
    const entry = { id: ++session.counter, route };
    session.routes.push(entry);
    if (session.routes.length > MAX_CACHED_ROUTES) session.routes.shift();
    selectRoute(entry.id);
    endProgress(
      "done",
      `${alternate ? "Alternate route" : "Route"} ready: ` +
        `${(route.lengthM / 1000).toFixed(2)} km, ` +
        `${Math.round(route.greenFraction * 100)}% on parks & connectors.`
    );
  } catch (error) {
    if (seq !== planSeq) return;
    endProgress("error", error instanceof NoRouteError ? error.message : `${error.message}`);
    $("result").style.display = "none";
  } finally {
    if (seq === planSeq) $("plan").disabled = $("alt").disabled = false;
  }
}

// Restart the current attempt with the same inputs — a fresh download often
// beats waiting out a stalled one.
$("retry").addEventListener("click", () => {
  if (!session) return;
  runPlan(planAlternate);
});

// Cached-route tabs: click to re-view a recent route without re-planning.
function renderRouteTabs() {
  const tabs = $("route-tabs");
  tabs.classList.toggle("visible", session.routes.length > 1);
  tabs.innerHTML = session.routes
    .map(
      ({ id, route }) => `
      <button type="button" role="tab" data-id="${id}"
              aria-selected="${id === session.activeId}"
              class="${id === session.activeId ? "active" : ""}">
        <b>Route ${id}</b> · ${(route.lengthM / 1000).toFixed(1)} km ·
        ${Math.round(route.greenFraction * 100)}%
      </button>`
    )
    .join("");
}

function selectRoute(id) {
  const entry = session.routes.find((r) => r.id === id);
  if (!entry) return;
  session.activeId = id;
  renderRouteTabs();
  showResult(session.start, entry.route);
}

$("route-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("button[data-id]");
  if (tab) selectRoute(Number(tab.dataset.id));
});

// Re-plan with the same start and distance, steering away from routes already shown.
$("alt").addEventListener("click", () => {
  if (!session) return;
  runPlan(true);
});

function showResult(start, route) {
  $("result").style.display = "block";
  $("stat-dist").textContent = (route.lengthM / 1000).toFixed(2) + " km";
  $("stat-green").textContent = Math.round(route.greenFraction * 100) + "%";
  $("stat-type").textContent = route.routeType.replaceAll("_", "-");
  $("stat-crossings").textContent = route.roadsCrossed;
  $("stat-elev").textContent =
    route.elevationGain === null ? "–" : `${Math.round(route.elevationGain)} m`;
  $("stat-sights").textContent = route.sights.length;
  $("gmaps").href = googleMapsUrl(route.coords);
  $("warnings").innerHTML = route.warnings.map((w) => `<li>${w}</li>`).join("");
  if (routeLayer) routeLayer.remove();
  const layers = [
    L.polyline(route.coords, { color: "#2e7d32", weight: 5, opacity: 0.85 }),
    L.marker([start.lat, start.lng]),
    ...route.sights.map((s) =>
      L.circleMarker([s.lat, s.lng], {
        radius: 6,
        color: "#0e3b2c",
        weight: 2.5,
        fillColor: "#fdfcf7",
        fillOpacity: 1,
      }).bindTooltip(s.name)
    ),
  ];
  if (route.routeType === "one_way") {
    const end = route.coords[route.coords.length - 1];
    layers.push(L.marker(end, { title: "Finish" }));
  }
  routeLayer = L.layerGroup(layers).addTo(map);
  map.fitBounds(L.polyline(route.coords).getBounds(), { padding: [20, 20] });
}

// ---- Deep links -------------------------------------------------------------
// e.g. /?lat=1.3521&lng=103.8198&distance=5, /?address=560406&distance=6, or
// /?country=GB&address=Hyde%20Park&distance=5
// (deep links auto-plan: the link already encodes the intent to run;
// `params` and the ?country= handling live in the country-selection section)

if (params.has("distance")) $("distance").value = params.get("distance");
if (params.get("shape") === "straight") {
  document.querySelector('input[name="shape"][value="straight"]').checked = true;
}
if (["none", "low", "high"].includes(params.get("elevation"))) {
  document.querySelector(`input[name="elev"][value="${params.get("elevation")}"]`).checked = true;
}
if (params.get("stay") === "yes") {
  document.querySelector('input[name="stay"][value="yes"]').checked = true;
}
if (params.get("sights") === "yes") {
  document.querySelector('input[name="sights"][value="yes"]').checked = true;
}
// A deep link that sets any preference opens the advanced section so the
// non-default settings are visible.
if (["shape", "elevation", "stay", "sights"].some((k) => params.has(k))) {
  $("advanced").open = true;
}
if (params.has("lat") && params.has("lng")) {
  coords = { lat: parseFloat(params.get("lat")), lng: parseFloat(params.get("lng")) };
  // Coordinate links carry their own location: follow them to the right
  // country when it wasn't (or was wrongly) given.
  if (!inBounds(coords.lat, coords.lng, country.bbox)) {
    const found = detectCountry(coords.lat, coords.lng);
    if (found) applyCountry(found);
  }
  $("form").requestSubmit();
} else if (params.has("address")) {
  const query = params.get("address");
  input.value = query;
  showStatus(`Finding “${query}”…`);
  geocode(query, country)
    .then((top) => {
      coords = { lat: top.lat, lng: top.lng };
      input.value = top.name;
      $("form").requestSubmit();
    })
    .catch((error) => showStatus(error.message, "error"));
}
