// Route search on a greenness-weighted graph — mirrors app/routing/loop.py.
//
// Graph shape: { nodes: Map<id, {lat, lng}>, adj: Map<id, [{to, length, w, green}]> }
//
// The search is turn-aware: Dijkstra runs over (arrived-from, node) states and
// every transition pays a penalty scaled by the turn angle, so straight, smooth
// paths are preferred over zigzags with the same length. Smooth curves cost
// nothing because they are many small angles between consecutive OSM nodes.

import { project } from "./geo.js";

export const LENGTH_TOLERANCE = 0.1;
export const RELAXED_TOLERANCE = 0.2;
const BEARING_STEP_DEG = 30;
const REUSE_PENALTY = 3.0;
const AVOID_PENALTY = 2.5; // edges of already-shown routes, for "Alternate route"
const MAX_ROUNDS = 3;
const MIN_LEG_M = 250;

// Turn penalties, in weighted meters added on top of the edge cost.
const TURN_FREE_DEG = 35; // gentle bends are free
const TURN_SHARP_DEG = 80;
const TURN_REVERSE_DEG = 130;
export const TURN_PENALTY_LIGHT = 8;
export const TURN_PENALTY_SHARP = 25;
export const TURN_PENALTY_REVERSE = 80;

// Road-crossing penalties by severity (weighted meters; green path costs 0.4/m,
// so 60 weighted-m ~ 150 m of green detour tolerated to avoid a minor road,
// and up to ~400 m to avoid crossing a primary road).
export const CROSS_PENALTY = [0, 60, 110, 160]; // index = road level

// Elevation preference ("none" = flattest, "low" = gentle rises ok, "high" =
// seek climbs). Penalties in weighted meters per meter climbed; "high" instead
// discounts climbing edges so the search is drawn toward them.
export const ELEV_PENALTY_PER_M = { none: 10, low: 1.5, high: 0 };
const HILL_DISCOUNT_MAX = 0.5; // a steep edge costs as little as half its weight

// "Stay in parks": non-green edges cost STAY_PENALTY x their weight, so streets
// become a last resort (a neutral street then costs 10x a green path per meter).
// When the result still falls short of STAY_GREEN_TARGET, the route carries a
// best-effort warning.
const STAY_PENALTY = 4.0;
export const STAY_GREEN_TARGET = 0.9;

// Notable sights (graph.sights): a gentle candidate-level bias, so a sight
// tips the balance between comparable routes without stretching distance.
const SIGHT_RADIUS_M = 60; // a sight this close to a path node counts as passed
const SIGHT_BONUS = 0.05; // score bump per distinct sight passed
const SIGHT_BONUS_CAP = 0.25;
const TREE_RERANK_TOP = 50; // tree candidates re-ranked with the sight bonus
const M_PER_DEG_LAT = 111320;

// Candidate-level scoring nudge: among route candidates, "none" prefers the
// flattest and "high" the hilliest, judged by average grade (gain / length).
function elevationScore(elev, gain, lengthM) {
  if (gain === null || lengthM === 0) return 0;
  const grade = gain / lengthM;
  if (elev === "none") return -grade * 20;
  if (elev === "high") return (Math.min(grade, 0.06) / 0.06) * 0.4;
  return 0;
}
export class NoRouteError extends Error {}

class MinHeap {
  constructor() {
    this.items = [];
  }
  push(priority, value) {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

const pairKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`);

function bearingDeg(graph, u, v) {
  const a = graph.nodes.get(u);
  const b = graph.nodes.get(v);
  const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return (Math.atan2((b.lng - a.lng) * scale, b.lat - a.lat) * 180) / Math.PI;
}

function turnAngleDeg(b1, b2) {
  const d = Math.abs(b1 - b2) % 360;
  return d > 180 ? 360 - d : d;
}

export function turnPenalty(angleDeg) {
  if (angleDeg < TURN_FREE_DEG) return 0;
  if (angleDeg < TURN_SHARP_DEG) return TURN_PENALTY_LIGHT;
  if (angleDeg < TURN_REVERSE_DEG) return TURN_PENALTY_SHARP;
  return TURN_PENALTY_REVERSE;
}

// Per-node adjacency with bearing and pair key memoized on the edge entries —
// the hot Dijkstra loop must not recompute trigonometry per relaxation.
function preparedAdj(graph, u) {
  const entries = graph.adj.get(u) ?? [];
  for (const edge of entries) {
    if (edge.bearing === undefined) {
      edge.bearing = bearingDeg(graph, u, edge.to);
      edge.pair = pairKey(u, edge.to);
      edge.road ??= 0;
      const climb = graph.elev
        ? Math.max(0, (graph.elev.get(edge.to) ?? 0) - (graph.elev.get(u) ?? 0))
        : 0;
      edge.gain = climb;
      edge.grade = edge.length > 0 ? climb / edge.length : 0;
    }
  }
  return entries;
}

function nodeRoadLevel(graph, u) {
  let level = 0;
  for (const edge of preparedAdj(graph, u)) if (edge.road > level) level = edge.road;
  return level;
}

// Turn-aware Dijkstra over (arrived-from, node) states. State keys are
// "from|node" ("" for the start's from); stateNode preserves original ids.
// Heap items carry the arrival edge's bearing to avoid lookups.
function dijkstra(graph, source, used = null, target = null, avoid = null, elev = "low", stay = false) {
  const startKey = `|${source}`;
  const dist = new Map([[startKey, 0]]);
  const prevState = new Map();
  const stateNode = new Map([[startKey, source]]);
  const settled = new Set();
  const heap = new MinHeap();
  heap.push(0, [source, null, startKey, null, false]);
  let targetKey = null;
  while (heap.size) {
    const [d, [u, from, key, bearingIn, arrivedByRoad]] = heap.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    if (u === target) {
      targetKey = key;
      break;
    }
    // Crossing a road at u: we pass through a road-carrying node while both
    // arriving and leaving on non-road paths (walking along a road is free).
    const uRoad = nodeRoadLevel(graph, u);
    for (const edge of preparedAdj(graph, u)) {
      if (edge.to === from) continue; // no immediate U-turns
      let w = edge.w;
      if (stay && !edge.green) w *= STAY_PENALTY;
      if (elev === "high") w *= Math.max(HILL_DISCOUNT_MAX, 1 - edge.grade * 5);
      else w += ELEV_PENALTY_PER_M[elev] * edge.gain;
      if (used && used.has(edge.pair)) w *= REUSE_PENALTY;
      if (avoid && avoid.has(edge.pair)) w *= AVOID_PENALTY;
      if (bearingIn !== null) {
        w += turnPenalty(turnAngleDeg(bearingIn, edge.bearing));
      }
      if (from !== null && !arrivedByRoad && !edge.road && uRoad > 0) {
        w += CROSS_PENALTY[uRoad];
      }
      const nd = d + w;
      const stateKey = `${u}|${edge.to}`;
      if (nd < (dist.get(stateKey) ?? Infinity)) {
        dist.set(stateKey, nd);
        prevState.set(stateKey, key);
        stateNode.set(stateKey, edge.to);
        heap.push(nd, [edge.to, u, stateKey, edge.bearing, edge.road > 0]);
      }
    }
  }
  return { dist, prevState, stateNode, settled, targetKey };
}

function statePath(prevState, stateNode, key) {
  const path = [];
  for (let k = key; k !== undefined; k = prevState.get(k)) path.push(stateNode.get(k));
  return path.reverse();
}

export function shortestPath(graph, a, b, used, avoid, elev = "low", stay = false) {
  const { prevState, stateNode, targetKey } = dijkstra(graph, a, used, b, avoid, elev, stay);
  return targetKey === null ? null : statePath(prevState, stateNode, targetKey);
}

function bestEdge(graph, u, v) {
  let best = null;
  for (const edge of graph.adj.get(u) ?? []) {
    if (edge.to === v && (best === null || edge.w < best.w)) best = edge;
  }
  return best;
}

function pathStats(graph, path) {
  let length = 0;
  let green = 0;
  for (let i = 1; i < path.length; i++) {
    const edge = bestEdge(graph, path[i - 1], path[i]);
    length += edge.length;
    if (edge.green) green += edge.length;
  }
  return { length, green };
}

// Roads crossed along the path: interior nodes carrying a road where the route
// arrives and leaves on non-road paths. Every such node counts, however close
// together — each carriageway of a dual carriageway is its own road.
function countRoadCrossings(graph, path) {
  let count = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const inEdge = bestEdge(graph, path[i - 1], path[i]);
    const outEdge = bestEdge(graph, path[i], path[i + 1]);
    if (!inEdge.road && !outEdge.road && nodeRoadLevel(graph, path[i]) > 0) count++;
  }
  return count;
}

function edgePairs(path) {
  const pairs = new Set();
  for (let i = 1; i < path.length; i++) pairs.add(pairKey(path[i - 1], path[i]));
  return pairs;
}

export function nearestNode(graph, lat, lng) {
  const scale = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  for (const [id, p] of graph.nodes) {
    const d = (p.lat - lat) ** 2 + ((p.lng - lng) * scale) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function* viaPairs(graph, start, legM, tried) {
  const { lat, lng } = graph.nodes.get(start);
  for (let bearing = 0; bearing < 360; bearing += BEARING_STEP_DEG) {
    const a = nearestNode(graph, ...project(lat, lng, bearing, legM));
    const b = nearestNode(graph, ...project(lat, lng, bearing + 120, legM));
    const key = `${a}>${b}`;
    if (new Set([start, a, b]).size < 3 || tried.has(key)) continue;
    tried.add(key);
    yield [a, b];
  }
}

function evaluateLoop(graph, start, a, b, targetM, avoid, elev, stay) {
  const leg1 = shortestPath(graph, start, a, null, avoid, elev, stay);
  if (!leg1) return null;
  const used = edgePairs(leg1);
  const leg2 = shortestPath(graph, a, b, used, avoid, elev, stay);
  if (!leg2) return null;
  for (const p of edgePairs(leg2)) used.add(p);
  const leg3 = shortestPath(graph, b, start, used, avoid, elev, stay);
  if (!leg3) return null;
  const path = [...leg1, ...leg2.slice(1), ...leg3.slice(1)];
  const { length, green } = pathStats(graph, path);
  if (length === 0) return null;
  const deviation = Math.abs(length - targetM) / targetM;
  const greenFraction = green / length;
  const score =
    greenFraction -
    2 * deviation +
    elevationScore(elev, elevationGains(graph, path)?.total ?? null, length) +
    sightScore(graph, path);
  return { score, deviation, path, length, greenFraction };
}

function findLoop(graph, start, targetM, avoid, elev, stay) {
  // Green-weighted shortest paths meander well past crow-flies distance, so
  // the right via-point spacing is unknown up front: start at target/3 and,
  // while the resulting loops miss the target, rescale the legs by the
  // median overshoot ratio and try again.
  const candidates = [];
  const tried = new Set();
  let leg = targetM / 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const roundLengths = [];
    for (const [a, b] of viaPairs(graph, start, leg, tried)) {
      const candidate = evaluateLoop(graph, start, a, b, targetM, avoid, elev, stay);
      if (!candidate) continue;
      candidates.push(candidate);
      roundLengths.push(candidate.length);
    }
    if (candidates.some((c) => c.deviation <= LENGTH_TOLERANCE) || !roundLengths.length) break;
    roundLengths.sort((x, y) => x - y);
    const median = roundLengths[roundLengths.length >> 1];
    leg = Math.max(MIN_LEG_M, (leg * targetM) / median);
  }

  for (const tolerance of [LENGTH_TOLERANCE, RELAXED_TOLERANCE]) {
    const fitting = candidates.filter((c) => c.deviation <= tolerance);
    if (!fitting.length) continue;
    const best = fitting.reduce((x, y) => (y.score > x.score ? y : x));
    const warnings = [];
    if (tolerance === RELAXED_TOLERANCE) {
      warnings.push(
        `closest loop found is ${(best.length / 1000).toFixed(1)} km ` +
          `(${Math.round(best.deviation * 100)}% off the requested distance)`
      );
    }
    return toResult(graph, best.path, best.length, best.greenFraction, "loop", warnings);
  }
  return null;
}

// Greenest-path tree from the start: per-state prev pointers plus true/green
// length, accumulated in increasing weighted distance so parents come first.
function greenestPathTree(graph, start, avoid, elev, stay) {
  const tree = dijkstra(graph, start, null, null, avoid, elev, stay);
  const order = [...tree.settled].sort((a, b) => tree.dist.get(a) - tree.dist.get(b));
  const lengthTo = new Map([[`|${start}`, 0]]);
  const greenTo = new Map([[`|${start}`, 0]]);
  const gainTo = new Map([[`|${start}`, 0]]);
  for (const key of order) {
    const parent = tree.prevState.get(key);
    if (parent === undefined) continue; // start state
    const parentNode = tree.stateNode.get(parent);
    const node = tree.stateNode.get(key);
    const edge = bestEdge(graph, parentNode, node);
    lengthTo.set(key, lengthTo.get(parent) + edge.length);
    greenTo.set(key, greenTo.get(parent) + (edge.green ? edge.length : 0));
    const delta = graph.elev
      ? (graph.elev.get(node) ?? 0) - (graph.elev.get(parentNode) ?? 0)
      : 0;
    gainTo.set(key, gainTo.get(parent) + Math.max(0, delta));
  }
  return { ...tree, lengthTo, greenTo, gainTo };
}

// State whose tree path best combines greenness with closeness to targetLen.
// The sight bonus needs the actual tree path, so only the TREE_RERANK_TOP
// base-scored candidates pay for a path walk before the final pick.
function bestTreeState(graph, tree, start, targetLen, elev) {
  const scored = [];
  for (const [key, length] of tree.lengthTo) {
    const node = tree.stateNode.get(key);
    if (node === start || length === 0) continue;
    const deviation = Math.abs(length - targetLen) / targetLen;
    const greenFraction = tree.greenTo.get(key) / length;
    const score =
      greenFraction - 2 * deviation + elevationScore(elev, tree.gainTo.get(key), length);
    scored.push({ score, key, length, deviation, greenFraction });
  }
  scored.sort((a, b) => b.score - a.score);
  let best = null;
  for (const candidate of scored.slice(0, TREE_RERANK_TOP)) {
    const path = statePath(tree.prevState, tree.stateNode, candidate.key);
    const score = candidate.score + sightScore(graph, path);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  return best;
}

function findOutAndBack(graph, start, targetM, avoid, elev, stay) {
  const tree = greenestPathTree(graph, start, avoid, elev, stay);
  const best = bestTreeState(graph, tree, start, targetM / 2, elev);
  if (!best) throw new NoRouteError("no reachable route from the start point");
  const out = statePath(tree.prevState, tree.stateNode, best.key);
  const path = [...out, ...out.slice(0, -1).reverse()];
  return toResult(graph, path, best.length * 2, best.greenFraction, "out_and_back", [
    "no loop matched the requested distance; returning an out-and-back route",
  ]);
}

// One-way "straight path": the full target distance in one direction along the
// greenest paths, ending away from the start.
function findOneWay(graph, start, targetM, avoid, elev, stay) {
  const tree = greenestPathTree(graph, start, avoid, elev, stay);
  const best = bestTreeState(graph, tree, start, targetM, elev);
  if (!best) throw new NoRouteError("no reachable route from the start point");
  const warnings = [];
  if (best.deviation > LENGTH_TOLERANCE) {
    warnings.push(
      `closest straight route is ${(best.length / 1000).toFixed(1)} km ` +
        `(${Math.round(best.deviation * 100)}% off the requested distance)`
    );
  }
  const path = statePath(tree.prevState, tree.stateNode, best.key);
  return toResult(graph, path, best.length, best.greenFraction, "one_way", warnings);
}

// { total, maxClimb } ascent in meters along the path (null when elevation
// data is missing). Total ascent drives candidate scoring; the largest single
// climb is what results report. A drop of at least the deadband ends a climb;
// smaller wobbles are hysteresis-filtered DEM noise.
const GAIN_DEADBAND_M = 2;
function elevationGains(graph, path) {
  if (!graph.elev) return null;
  let total = 0;
  let climb = 0;
  let maxClimb = 0;
  let anchor = graph.elev.get(path[0]) ?? 0;
  for (let i = 1; i < path.length; i++) {
    const elev = graph.elev.get(path[i]) ?? 0;
    const delta = elev - anchor;
    if (delta >= GAIN_DEADBAND_M) {
      total += delta;
      climb += delta;
      maxClimb = Math.max(maxClimb, climb);
      anchor = elev;
    } else if (delta <= -GAIN_DEADBAND_M) {
      climb = 0;
      anchor = elev;
    }
  }
  return { total, maxClimb };
}

// node -> sight index, for nodes within SIGHT_RADIUS_M of a sight. Cached on
// the graph object; candidate scoring only touches this map.
function sightNodes(graph) {
  if (graph._sightNodes) return graph._sightNodes;
  const map = new Map();
  for (const [i, sight] of (graph.sights ?? []).entries()) {
    const scale = Math.cos((sight.lat * Math.PI) / 180);
    for (const [id, p] of graph.nodes) {
      if (map.has(id)) continue;
      const dLat = (p.lat - sight.lat) * M_PER_DEG_LAT;
      const dLng = (p.lng - sight.lng) * M_PER_DEG_LAT * scale;
      if (dLat * dLat + dLng * dLng <= SIGHT_RADIUS_M * SIGHT_RADIUS_M) map.set(id, i);
    }
  }
  graph._sightNodes = map;
  return map;
}

// Distinct sights passed along the path, in encounter order.
function pathSights(graph, path) {
  const nodeSight = sightNodes(graph);
  const seen = [];
  for (const node of path) {
    const i = nodeSight.get(node);
    if (i !== undefined && !seen.includes(i)) seen.push(i);
  }
  return seen.map((i) => graph.sights[i]);
}

function sightScore(graph, path) {
  return Math.min(SIGHT_BONUS * pathSights(graph, path).length, SIGHT_BONUS_CAP);
}

function toResult(graph, path, lengthM, greenFraction, routeType, warnings) {
  const coords = path.map((n) => {
    const p = graph.nodes.get(n);
    return [p.lat, p.lng];
  });
  return {
    coords,
    lengthM,
    greenFraction,
    routeType,
    warnings,
    pairs: [...edgePairs(path)],
    roadsCrossed: countRoadCrossings(graph, path),
    elevationGain: elevationGains(graph, path)?.maxClimb ?? null,
    sights: pathSights(graph, path),
  };
}

// shape: "loop" (default) or "straight" (one-way, ends away from the start).
// avoid: Set of edge pair-keys (from previous results' `pairs`) to steer away
// from, so "Alternate route" produces a genuinely different loop.
// elev: "none" (flattest) | "low" (default, gentle rises ok) | "high" (seek climbs).
export function planRoute(
  graph, lat, lng, targetM, avoid = null, shape = "loop", elev = "low", stay = false
) {
  if (graph.nodes.size < 2) {
    throw new NoRouteError("no walkable paths found around the start point");
  }
  const start = nearestNode(graph, lat, lng);
  const route =
    shape === "straight"
      ? findOneWay(graph, start, targetM, avoid, elev, stay)
      : findLoop(graph, start, targetM, avoid, elev, stay) ??
        findOutAndBack(graph, start, targetM, avoid, elev, stay);
  if (stay && route.greenFraction < STAY_GREEN_TARGET) {
    route.warnings.push(
      "stayed in parks and along water where possible — " +
        `${Math.round((1 - route.greenFraction) * 100)}% of this route still follows ` +
        "streets to connect the green stretches"
    );
  }
  return route;
}
