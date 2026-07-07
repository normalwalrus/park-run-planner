// Fetch the OSM walking network + park polygons around a point via Overpass,
// and build the scored routing graph — mirrors app/routing/graph.py.

import { haversineM, pointInRing } from "./geo.js";
import { edgeFactor, GREEN_FACTOR } from "./scoring.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const WALK_HIGHWAYS =
  "footway|path|pedestrian|track|cycleway|bridleway|residential|living_street|" +
  "service|unclassified|tertiary|tertiary_link|secondary|secondary_link|" +
  "primary|primary_link|trunk|trunk_link";
const PARK_LEISURE = "park|nature_reserve|garden";
const PARK_LANDUSE = "recreation_ground|grass";

const MIN_RADIUS_M = 1000;
const MAX_RADIUS_M = 6000;

const cache = new Map();
const CACHE_MAX = 4;

export function radiusFor(distanceM) {
  // A loop of length L rarely extends past ~L/2.5 from its start.
  return Math.min(Math.max(distanceM / 2.2 + 400, MIN_RADIUS_M), MAX_RADIUS_M);
}

function query(lat, lng, radius) {
  const around = `around:${Math.round(radius)},${lat},${lng}`;
  return `[out:json][timeout:60];
(
  way(${around})["highway"~"^(${WALK_HIGHWAYS})$"];
  way(${around})["leisure"~"^(${PARK_LEISURE})$"];
  way(${around})["landuse"~"^(${PARK_LANDUSE})$"];
);
out geom;`;
}

async function fetchOverpass(lat, lng, radius) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: `data=${encodeURIComponent(query(lat, lng, radius))}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not load map data: ${lastError?.message ?? "unknown error"}`);
}

function isPark(tags) {
  return (
    new RegExp(`^(${PARK_LEISURE})$`).test(tags.leisure ?? "") ||
    new RegExp(`^(${PARK_LANDUSE})$`).test(tags.landuse ?? "")
  );
}

// elements: Overpass ways with `geometry` ([{lat, lon}]) and `nodes` (ids).
export function buildGraph(elements) {
  const nodes = new Map();
  const adj = new Map();
  const edges = [];
  const parks = [];

  for (const way of elements) {
    if (way.type !== "way" || !way.geometry || !way.nodes) continue;
    const tags = way.tags ?? {};
    if (isPark(tags)) {
      const ring = way.geometry.map((p) => [p.lat, p.lon]);
      if (ring.length >= 4) {
        const lats = ring.map((p) => p[0]);
        const lngs = ring.map((p) => p[1]);
        parks.push({
          ring,
          bbox: [
            Math.min(...lats),
            Math.min(...lngs),
            Math.max(...lats),
            Math.max(...lngs),
          ],
        });
      }
    }
    if (!tags.highway) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const [u, v] = [way.nodes[i - 1], way.nodes[i]];
      const [pu, pv] = [way.geometry[i - 1], way.geometry[i]];
      if (pu === undefined || pv === undefined) continue;
      nodes.set(u, { lat: pu.lat, lng: pu.lon });
      nodes.set(v, { lat: pv.lat, lng: pv.lon });
      edges.push({
        u,
        v,
        length: haversineM([pu.lat, pu.lon], [pv.lat, pv.lon]),
        highway: tags.highway,
        name: tags.name,
        mid: [(pu.lat + pv.lat) / 2, (pu.lon + pv.lon) / 2],
      });
    }
  }

  for (const edge of edges) {
    const [lat, lng] = edge.mid;
    const inPark = parks.some(
      (p) =>
        lat >= p.bbox[0] &&
        lng >= p.bbox[1] &&
        lat <= p.bbox[2] &&
        lng <= p.bbox[3] &&
        pointInRing(lat, lng, p.ring)
    );
    const factor = edgeFactor({ highway: edge.highway, name: edge.name, inPark });
    const scored = { length: edge.length, w: edge.length * factor, green: factor === GREEN_FACTOR };
    if (!adj.has(edge.u)) adj.set(edge.u, []);
    if (!adj.has(edge.v)) adj.set(edge.v, []);
    adj.get(edge.u).push({ to: edge.v, ...scored });
    adj.get(edge.v).push({ to: edge.u, ...scored });
  }

  return { nodes, adj };
}

export async function loadGraph(lat, lng, distanceM) {
  const radius = radiusFor(distanceM);
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.floor(radius / 500)}`;
  if (cache.has(key)) return cache.get(key);
  const data = await fetchOverpass(lat, lng, radius);
  const graph = buildGraph(data.elements ?? []);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, graph);
  return graph;
}
