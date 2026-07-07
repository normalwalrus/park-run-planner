// UI wiring: run the whole planning pipeline in the browser (Singapore only).

import { geocode, search, mergeSuggestions } from "./geocode.js";
import { SG_BOUNDS, inSingapore } from "./geo.js";
import { loadGraph, isGraphCached } from "./overpass.js";
import { planRoute, NoRouteError } from "./loop.js";
import { googleMapsUrl } from "./maps.js";

const SG_CENTER = [1.3521, 103.8198];
const OUTSIDE_SG = "Park Run Planner currently covers Singapore only.";
const MIN_QUERY_CHARS = 3;
const DEBOUNCE_MS = 250;

// Popular running spots, ranked first in the dropdown when they match.
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
const $ = (id) => document.getElementById(id);

// Map is shown from the start, locked to Singapore.
const [south, west, north, east] = SG_BOUNDS;
const map = L.map("map", {
  maxBounds: [
    [south - 0.02, west - 0.02],
    [north + 0.02, east + 0.02],
  ],
  maxBoundsViscosity: 1.0,
  minZoom: 11,
});
map.setView(SG_CENTER, 12);
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
}

function startProgress(message, seconds) {
  card.hidden = false;
  card.className = "";
  $("status-text").textContent = message;
  $("bar").hidden = false;
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

function tick() {
  const elapsed = elapsedSeconds();
  const overrun = elapsed > estimateS;
  card.classList.toggle("overrun", overrun);
  $("bar-fill").style.width = `${Math.min((elapsed / estimateS) * 100, 97)}%`;
  $("status-time").textContent = overrun
    ? `${elapsed.toFixed(1)} s — taking longer than expected`
    : `${elapsed.toFixed(1)} s elapsed · ~${Math.round(estimateS)} s expected`;
}

function endProgress(kind, message) {
  const elapsed = elapsedSeconds();
  stopTicker();
  card.className = kind;
  $("status-text").textContent = message;
  if (kind === "done") {
    $("bar-fill").style.width = "100%";
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

input.addEventListener("input", () => {
  coords = null;
  clearTimeout(debounceTimer);
  const query = input.value.trim();
  if (query.length < MIN_QUERY_CHARS) return closeSuggestions();
  debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
});

async function runSearch(query) {
  const seq = ++searchSeq;
  let results = [];
  try {
    results = await search(query);
  } catch {
    results = []; // suggestion failures are silent; curated spots may still match
  }
  if (seq !== searchSeq || input.value.trim() !== query) return; // stale response
  suggestions = mergeSuggestions(SPOTS, results, query);
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

// ---- Location + planning ----------------------------------------------------

$("locate").addEventListener("click", () => {
  showStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!inSingapore(here.lat, here.lng)) return showStatus(OUTSIDE_SG, "error");
      coords = here;
      input.value = "";
      showStatus(
        `Start point set: your location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}). ` +
          "Press “Plan my run” to plan your route."
      );
    },
    () => showStatus("Could not get your location — search for a place instead.", "error")
  );
});

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
      showStatus("Search for a place or postal code, or use your location.", "error");
    }
    return;
  }
  if (!inSingapore(coords.lat, coords.lng)) return showStatus(OUTSIDE_SG, "error");
  $("plan").disabled = true;
  try {
    await plan(coords, distanceKm);
  } finally {
    $("plan").disabled = false;
  }
});

function estimateSeconds(start, distanceKm) {
  const download = isGraphCached(start.lat, start.lng, distanceKm * 1000) ? 1 : 15;
  const searchTime = 1 + distanceKm * 0.2; // loop search grows with area
  return download + searchTime;
}

async function plan(start, distanceKm) {
  startProgress("Downloading map data for this area…", estimateSeconds(start, distanceKm));
  try {
    const graph = await loadGraph(start.lat, start.lng, distanceKm * 1000);
    setStage("Searching for the greenest loop…");
    await new Promise((r) => setTimeout(r)); // let the status paint before the search blocks
    const route = planRoute(graph, start.lat, start.lng, distanceKm * 1000);
    showResult(start, route);
    endProgress(
      "done",
      `Route ready: ${(route.lengthM / 1000).toFixed(2)} km, ` +
        `${Math.round(route.greenFraction * 100)}% on parks & connectors.`
    );
  } catch (error) {
    endProgress("error", error instanceof NoRouteError ? error.message : `${error.message}`);
    $("result").style.display = "none";
  }
}

function showResult(start, route) {
  $("result").style.display = "block";
  $("stat-dist").textContent = (route.lengthM / 1000).toFixed(2) + " km";
  $("stat-green").textContent = Math.round(route.greenFraction * 100) + "%";
  $("stat-type").textContent = route.routeType.replaceAll("_", "-");
  $("gmaps").href = googleMapsUrl(route.coords);
  $("warnings").innerHTML = route.warnings.map((w) => `<li>${w}</li>`).join("");
  if (routeLayer) routeLayer.remove();
  routeLayer = L.layerGroup([
    L.polyline(route.coords, { color: "#2e7d32", weight: 5, opacity: 0.85 }),
    L.marker([start.lat, start.lng]),
  ]).addTo(map);
  map.fitBounds(L.polyline(route.coords).getBounds(), { padding: [20, 20] });
}

// ---- Deep links -------------------------------------------------------------
// e.g. /?lat=1.3521&lng=103.8198&distance=5 or /?address=560406&distance=6
// (deep links auto-plan: the link already encodes the intent to run)

const params = new URLSearchParams(location.search);
if (params.has("distance")) $("distance").value = params.get("distance");
if (params.has("lat") && params.has("lng")) {
  coords = { lat: parseFloat(params.get("lat")), lng: parseFloat(params.get("lng")) };
  $("form").requestSubmit();
} else if (params.has("address")) {
  const query = params.get("address");
  input.value = query;
  showStatus(`Finding “${query}”…`);
  geocode(query)
    .then((top) => {
      coords = { lat: top.lat, lng: top.lng };
      input.value = top.name;
      $("form").requestSubmit();
    })
    .catch((error) => showStatus(error.message, "error"));
}
