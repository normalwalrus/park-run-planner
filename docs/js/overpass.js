// Fetch the OSM walking network + park polygons around a point via Overpass,
// and build the scored routing graph — mirrors app/routing/graph.py.

import { annotateElevation } from "./elevation.js";
import { haversineM, pointInRing } from "./geo.js";
import { edgeFactor, roadLevel, GREEN_FACTOR } from "./scoring.js";

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
// Notable sights: named tourist/historic features; named parks double as sights.
const SIGHT_TOURISM = "attraction|viewpoint|artwork|museum";
// Waterside: rivers, canals, reservoirs, and the coast make green running too.
const WATER_NATURAL = "water|coastline";
const WATER_WAYS = "river|canal|stream";
const WATER_NEAR_M = 40; // an edge this close to water counts as waterside

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
  node(${around})["tourism"~"^(${SIGHT_TOURISM})$"]["name"];
  way(${around})["tourism"~"^(${SIGHT_TOURISM})$"]["name"];
  node(${around})["historic"]["name"];
  way(${around})["historic"]["name"];
  way(${around})["natural"~"^(${WATER_NATURAL})$"];
  way(${around})["waterway"~"^(${WATER_WAYS})$"];
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

function isWater(tags) {
  return (
    new RegExp(`^(${WATER_NATURAL})$`).test(tags.natural ?? "") ||
    new RegExp(`^(${WATER_WAYS})$`).test(tags.waterway ?? "")
  );
}

// Distance in meters from (lat, lng) to the polyline, equirectangular locally
// (Singapore sits on the equator, so one scale serves both axes fine).
const M_PER_DEG = 111320;
function distToPolylineM(lat, lng, points) {
  const scale = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const ax = (points[i - 1].lon - lng) * M_PER_DEG * scale;
    const ay = (points[i - 1].lat - lat) * M_PER_DEG;
    const bx = (points[i].lon - lng) * M_PER_DEG * scale;
    const by = (points[i].lat - lat) * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, px * px + py * py);
  }
  return Math.sqrt(best);
}

function isSight(tags) {
  return (
    Boolean(tags.name) &&
    (new RegExp(`^(${SIGHT_TOURISM})$`).test(tags.tourism ?? "") ||
      Boolean(tags.historic) ||
      new RegExp(`^(${PARK_LEISURE})$`).test(tags.leisure ?? ""))
  );
}

function elementCenter(el) {
  if (el.type === "node") return [el.lat, el.lon];
  const points = el.geometry ?? [];
  if (points.length === 0) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return [lat, lng];
}

// elements: Overpass ways with `geometry` ([{lat, lon}]) and `nodes` (ids),
// plus sight nodes with `lat`/`lon`.
export function buildGraph(elements) {
  const nodes = new Map();
  const adj = new Map();
  const edges = [];
  const parks = [];
  const waters = [];
  const sights = [];
  const sightNames = new Set();
  const nearDeg = WATER_NEAR_M / M_PER_DEG;

  for (const way of elements) {
    const tags = way.tags ?? {};
    if (way.type === "way" && way.geometry && isWater(tags)) {
      const points = way.geometry;
      const lats = points.map((p) => p.lat);
      const lngs = points.map((p) => p.lon);
      waters.push({
        points,
        bbox: [
          Math.min(...lats) - nearDeg,
          Math.min(...lngs) - nearDeg,
          Math.max(...lats) + nearDeg,
          Math.max(...lngs) + nearDeg,
        ],
      });
    }
    if (isSight(tags) && !sightNames.has(tags.name)) {
      const center = elementCenter(way);
      if (center) {
        sightNames.add(tags.name);
        sights.push({ name: tags.name, lat: center[0], lng: center[1] });
      }
    }
    if (way.type !== "way" || !way.geometry || !way.nodes) continue;
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
    const nearWater =
      !inPark &&
      waters.some(
        (w) =>
          lat >= w.bbox[0] &&
          lng >= w.bbox[1] &&
          lat <= w.bbox[2] &&
          lng <= w.bbox[3] &&
          distToPolylineM(lat, lng, w.points) <= WATER_NEAR_M
      );
    const factor = edgeFactor({ highway: edge.highway, name: edge.name, inPark, nearWater });
    const road = roadLevel(edge.highway);
    const scored = {
      length: edge.length,
      w: edge.length * factor,
      green: factor === GREEN_FACTOR,
      road,
    };
    if (!adj.has(edge.u)) adj.set(edge.u, []);
    if (!adj.has(edge.v)) adj.set(edge.v, []);
    adj.get(edge.u).push({ to: edge.v, ...scored });
    adj.get(edge.v).push({ to: edge.u, ...scored });
  }

  return { ...keepLargestComponent(nodes, adj), sights };
}

// Keep only the largest connected component, like osmnx does — otherwise the
// start point can snap onto an isolated path fragment and yield a ~0 km route.
function keepLargestComponent(nodes, adj) {
  const seen = new Set();
  let largest = [];
  for (const startNode of adj.keys()) {
    if (seen.has(startNode)) continue;
    const component = [startNode];
    seen.add(startNode);
    for (let i = 0; i < component.length; i++) {
      for (const edge of adj.get(component[i]) ?? []) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          component.push(edge.to);
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const keep = new Set(largest);
  return {
    nodes: new Map([...nodes].filter(([id]) => keep.has(id))),
    adj: new Map([...adj].filter(([id]) => keep.has(id))),
  };
}

function cacheKey(lat, lng, distanceM) {
  const radius = radiusFor(distanceM);
  return `${lat.toFixed(3)},${lng.toFixed(3)},${Math.floor(radius / 500)}`;
}

// Lets the UI base its time estimate on whether a download is needed.
export function isGraphCached(lat, lng, distanceM) {
  return cache.has(cacheKey(lat, lng, distanceM));
}

export async function loadGraph(lat, lng, distanceM) {
  const key = cacheKey(lat, lng, distanceM);
  const radius = radiusFor(distanceM);
  if (cache.has(key)) return cache.get(key);
  const data = await fetchOverpass(lat, lng, radius);
  const graph = buildGraph(data.elements ?? []);
  await annotateElevation(graph); // sets graph.elev; absent = preference ignored
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, graph);
  return graph;
}
