// Fetch the OSM walking network + park polygons around a point via Overpass,
// and build the scored routing graph — mirrors app/routing/graph.py.

import { annotateElevation } from "./elevation.js";
import { haversineM, pointInRing } from "./geo.js";
import { edgeFactor, roadLevel, GREEN_FACTOR } from "./scoring.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const FETCH_TIMEOUT_MS = 30_000; // per-endpoint abort — a hung mirror must not stall the plan
const HEDGE_DELAY_MS = 8_000; // no answer yet? start the next mirror in parallel
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
  return `[out:json][timeout:30];
(
  way(${around})["highway"~"^(${WALK_HIGHWAYS})$"];
  way(${around})["leisure"~"^(${PARK_LEISURE})$"];
  way(${around})["landuse"~"^(${PARK_LANDUSE})$"];
  nw(${around})["tourism"~"^(${SIGHT_TOURISM})$"]["name"];
  nw(${around})["historic"]["name"];
  way(${around})["natural"~"^(${WATER_NATURAL})$"];
  way(${around})["waterway"~"^(${WATER_WAYS})$"];
);
out geom;`;
}

// Hedged requests: the public Overpass mirrors regularly hang or overload, so
// each attempt gets its own timeout, and when an endpoint has not answered
// within HEDGE_DELAY_MS the next mirror is queried in parallel — the first
// success wins and the rest are aborted.
function fetchOverpass(lat, lng, radius) {
  const body = `data=${encodeURIComponent(query(lat, lng, radius))}`;
  const controllers = [];
  let launched = 0;
  let settled = false;

  const attempt = async (endpoint) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.elements)) throw new Error("returned no data");
      return data;
    } finally {
      clearTimeout(timer);
    }
  };

  return new Promise((resolve, reject) => {
    const errors = [];
    const launchNext = () => {
      if (settled || launched >= ENDPOINTS.length) return;
      const endpoint = ENDPOINTS[launched++];
      attempt(endpoint).then(
        (data) => {
          if (settled) return;
          settled = true;
          for (const c of controllers) c.abort();
          resolve(data);
        },
        (error) => {
          errors.push(`${new URL(endpoint).host}: ${error.message}`);
          if (settled) return;
          if (launched < ENDPOINTS.length) launchNext();
          else if (errors.length === ENDPOINTS.length) {
            settled = true;
            reject(new Error(`could not load map data (${errors.join("; ")})`));
          }
        }
      );
      if (launched < ENDPOINTS.length) setTimeout(launchNext, HEDGE_DELAY_MS).unref?.();
    };
    launchNext();
  });
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
// (longitude scaled by cos(lat), so it holds up away from the equator too).
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
      // Longitude degrees shrink by cos(lat), so the corridor needs a wider
      // east-west margin away from the equator.
      const meanLat = lats.reduce((s, v) => s + v, 0) / lats.length;
      const nearDegLng = nearDeg / Math.cos((meanLat * Math.PI) / 180);
      waters.push({
        points,
        bbox: [
          Math.min(...lats) - nearDeg,
          Math.min(...lngs) - nearDegLng,
          Math.max(...lats) + nearDeg,
          Math.max(...lngs) + nearDegLng,
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

// ---- Persistent payload cache (IndexedDB) -----------------------------------
// The in-memory cache dies with the page, so before this every reload paid the
// Overpass download again. Raw elements persist for a week per area, keyed like
// the memory cache; QUERY_VERSION invalidates entries when query() changes.

const QUERY_VERSION = 2;
const IDB_NAME = "park-run-planner";
const IDB_STORE = "overpass";
const IDB_TTL_MS = 7 * 24 * 3600 * 1000;
const IDB_MAX = 8;
const hasIdb = typeof indexedDB !== "undefined";
const persistedKeys = new Set(); // synchronous view for isGraphCached / estimates

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(mode, run) {
  if (!hasIdb) return Promise.resolve(null);
  return idb()
    .then(
      (db) =>
        new Promise((resolve, reject) => {
          const store = db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
          const req = run(store);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        })
    )
    .catch(() => null); // cache failures must never break planning
}

async function idbGetElements(key) {
  const row = await idbRequest("readonly", (store) => store.get(key));
  if (!row || row.version !== QUERY_VERSION || Date.now() - row.time > IDB_TTL_MS) return null;
  return row.elements;
}

async function idbPutElements(key, elements) {
  await idbRequest("readwrite", (store) =>
    store.put({ key, version: QUERY_VERSION, time: Date.now(), elements })
  );
  persistedKeys.add(key);
  const rows = (await idbRequest("readonly", (store) => store.getAll())) ?? [];
  const stale = rows
    .filter((r) => r.version !== QUERY_VERSION || Date.now() - r.time > IDB_TTL_MS)
    .concat(rows.sort((a, b) => a.time - b.time).slice(0, Math.max(0, rows.length - IDB_MAX)));
  for (const row of stale) {
    persistedKeys.delete(row.key);
    await idbRequest("readwrite", (store) => store.delete(row.key));
  }
}

if (hasIdb) {
  idbRequest("readonly", (store) => store.getAll()).then((rows) => {
    for (const row of rows ?? []) {
      if (row.version === QUERY_VERSION && Date.now() - row.time <= IDB_TTL_MS) {
        persistedKeys.add(row.key);
      }
    }
  });
}

function cacheKey(lat, lng, distanceM) {
  const radius = radiusFor(distanceM);
  return `${lat.toFixed(3)},${lng.toFixed(3)},${Math.floor(radius / 500)}`;
}

// Lets the UI base its time estimate on whether a download is needed.
export function isGraphCached(lat, lng, distanceM) {
  const key = cacheKey(lat, lng, distanceM);
  return cache.has(key) || persistedKeys.has(key);
}

export async function loadGraph(lat, lng, distanceM) {
  const key = cacheKey(lat, lng, distanceM);
  const radius = radiusFor(distanceM);
  if (cache.has(key)) return cache.get(key);
  let elements = await idbGetElements(key);
  if (!elements) {
    const data = await fetchOverpass(lat, lng, radius);
    elements = data.elements ?? [];
    idbPutElements(key, elements); // fire-and-forget; planning must not wait on it
  }
  const graph = buildGraph(elements);
  await annotateElevation(graph); // sets graph.elev; absent = preference ignored
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, graph);
  return graph;
}
