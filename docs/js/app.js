// UI wiring: run the whole planning pipeline in the browser.

import { geocode } from "./geocode.js";
import { loadGraph } from "./overpass.js";
import { planRoute, NoRouteError } from "./loop.js";
import { googleMapsUrl } from "./maps.js";

let coords = null;
let map = null;
let routeLayer = null;
const $ = (id) => document.getElementById(id);

$("locate").addEventListener("click", () => {
  setStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $("address").value = "";
      setStatus(`Using current location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
    },
    () => setStatus("Could not get your location — type an address instead.", true)
  );
});

$("address").addEventListener("input", () => {
  coords = null;
});

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
      if (!address) return setStatus("Use your location or type an address first.", true);
      setStatus("Looking up address…");
      start = await geocode(address);
    }
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
  if (!map) {
    map = L.map("map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
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
  $("form").requestSubmit();
}
