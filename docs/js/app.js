// UI wiring: run the whole planning pipeline in the browser (Singapore only).

import { geocode } from "./geocode.js";
import { SG_BOUNDS, inSingapore } from "./geo.js";
import { loadGraph } from "./overpass.js";
import { planRoute, NoRouteError } from "./loop.js";
import { googleMapsUrl } from "./maps.js";

const SG_CENTER = [1.3521, 103.8198];
const OUTSIDE_SG = "Park Run Planner currently covers Singapore only — pick a spot below or type a Singapore address.";

// Popular Singapore running spots — picking one skips geocoding entirely.
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

// Suggestion chips + datalist from the same list.
$("spots").innerHTML = SPOTS.map(
  (s, i) => `<button type="button" class="spot" data-i="${i}">${s.name}</button>`
).join("");
$("spot-options").innerHTML = SPOTS.map((s) => `<option value="${s.name}"></option>`).join("");
$("spots").addEventListener("click", (event) => {
  const chip = event.target.closest(".spot");
  if (!chip) return;
  const spot = SPOTS[Number(chip.dataset.i)];
  coords = { lat: spot.lat, lng: spot.lng };
  $("address").value = spot.name;
  $("form").requestSubmit();
});

$("locate").addEventListener("click", () => {
  setStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!inSingapore(here.lat, here.lng)) return setStatus(OUTSIDE_SG, true);
      coords = here;
      $("address").value = "";
      setStatus(`Using current location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
    },
    () => setStatus("Could not get your location — type a Singapore address instead.", true)
  );
});

$("address").addEventListener("input", () => {
  coords = null;
  const spot = findSpot($("address").value);
  if (spot) coords = { lat: spot.lat, lng: spot.lng };
});

function findSpot(text) {
  const wanted = text.trim().toLowerCase();
  return SPOTS.find((s) => s.name.toLowerCase() === wanted) ?? null;
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const distanceKm = parseFloat($("distance").value);
  if (!(distanceKm >= 1 && distanceKm <= 30)) {
    return setStatus("Distance must be between 1 and 30 km.", true);
  }
  $("plan").disabled = true;
  try {
    let start = coords;
    if (!start) {
      const address = $("address").value.trim();
      if (!address) return setStatus("Use your location, pick a spot, or type an address.", true);
      setStatus("Looking up address…");
      start = await geocode(address);
    }
    if (!inSingapore(start.lat, start.lng)) return setStatus(OUTSIDE_SG, true);
    setStatus("Downloading map data — first time for an area can take ~10 s…");
    const graph = await loadGraph(start.lat, start.lng, distanceKm * 1000);
    setStatus("Searching for the greenest loop…");
    await new Promise((r) => setTimeout(r)); // let the status paint before the search blocks
    const route = planRoute(graph, start.lat, start.lng, distanceKm * 1000);
    showResult(start, route);
    setStatus("");
  } catch (error) {
    setStatus(error instanceof NoRouteError ? error.message : `${error.message}`, true);
    $("result").style.display = "none";
  } finally {
    $("plan").disabled = false;
  }
});

function setStatus(message, isError) {
  $("status").textContent = message;
  $("status").className = isError ? "error" : "";
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

// Auto-plan from query params, e.g. /?lat=1.3521&lng=103.8198&distance=5
const params = new URLSearchParams(location.search);
if (params.has("distance")) $("distance").value = params.get("distance");
if (params.has("lat") && params.has("lng")) {
  coords = { lat: parseFloat(params.get("lat")), lng: parseFloat(params.get("lng")) };
  $("form").requestSubmit();
} else if (params.has("address")) {
  $("address").value = params.get("address");
  coords = findSpot(params.get("address"))
    ? { lat: findSpot(params.get("address")).lat, lng: findSpot(params.get("address")).lng }
    : null;
  $("form").requestSubmit();
}
