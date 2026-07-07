// Loop search on a greenness-weighted graph — mirrors app/routing/loop.py.
//
// Graph shape: { nodes: Map<id, {lat, lng}>, adj: Map<id, [{to, length, w, green}]> }

import { project } from "./geo.js";

export const LENGTH_TOLERANCE = 0.1;
export const RELAXED_TOLERANCE = 0.2;
const BEARING_STEP_DEG = 30;
const REUSE_PENALTY = 3.0;
const AVOID_PENALTY = 2.5; // edges of already-shown routes, for "Alternate route"
const MAX_ROUNDS = 3;
const MIN_LEG_M = 250;

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

function dijkstra(graph, source, used = null, target = null, avoid = null) {
  const dist = new Map([[source, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap();
  heap.push(0, source);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === target) break;
    for (const edge of graph.adj.get(u) ?? []) {
      let w = edge.w;
      const key = pairKey(u, edge.to);
      if (used && used.has(key)) w *= REUSE_PENALTY;
      if (avoid && avoid.has(key)) w *= AVOID_PENALTY;
      const nd = d + w;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, u);
        heap.push(nd, edge.to);
      }
    }
  }
  return { dist, prev, done };
}

function shortestPath(graph, a, b, used, avoid) {
  const { prev, done } = dijkstra(graph, a, used, b, avoid);
  if (!done.has(b)) return null;
  const path = [b];
  while (path[path.length - 1] !== a) path.push(prev.get(path[path.length - 1]));
  return path.reverse();
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

function evaluateLoop(graph, start, a, b, targetM, avoid) {
  const leg1 = shortestPath(graph, start, a, null, avoid);
  if (!leg1) return null;
  const used = edgePairs(leg1);
  const leg2 = shortestPath(graph, a, b, used, avoid);
  if (!leg2) return null;
  for (const p of edgePairs(leg2)) used.add(p);
  const leg3 = shortestPath(graph, b, start, used, avoid);
  if (!leg3) return null;
  const path = [...leg1, ...leg2.slice(1), ...leg3.slice(1)];
  const { length, green } = pathStats(graph, path);
  if (length === 0) return null;
  const deviation = Math.abs(length - targetM) / targetM;
  const greenFraction = green / length;
  return { score: greenFraction - 2 * deviation, deviation, path, length, greenFraction };
}

function findLoop(graph, start, targetM, avoid) {
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
      const candidate = evaluateLoop(graph, start, a, b, targetM, avoid);
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

function findOutAndBack(graph, start, targetM, avoid) {
  const { dist, prev } = dijkstra(graph, start, null, null, avoid);
  // Accumulate true length and green length along the shortest-path tree,
  // visiting nodes in increasing weighted distance so parents come first.
  const order = [...dist.keys()].sort((a, b) => dist.get(a) - dist.get(b));
  const lengthTo = new Map([[start, 0]]);
  const greenTo = new Map([[start, 0]]);
  for (const node of order) {
    if (node === start) continue;
    const pred = prev.get(node);
    const edge = bestEdge(graph, pred, node);
    lengthTo.set(node, lengthTo.get(pred) + edge.length);
    greenTo.set(node, greenTo.get(pred) + (edge.green ? edge.length : 0));
  }

  const half = targetM / 2;
  let best = null;
  for (const [node, length] of lengthTo) {
    if (node === start || length === 0) continue;
    const deviation = Math.abs(length - half) / half;
    const score = greenTo.get(node) / length - 2 * deviation;
    if (!best || score > best.score) {
      best = { score, node, length, greenFraction: greenTo.get(node) / length };
    }
  }
  if (!best) throw new NoRouteError("no reachable route from the start point");

  const out = [best.node];
  while (out[out.length - 1] !== start) out.push(prev.get(out[out.length - 1]));
  out.reverse();
  const path = [...out, ...out.slice(0, -1).reverse()];
  return toResult(graph, path, best.length * 2, best.greenFraction, "out_and_back", [
    "no loop matched the requested distance; returning an out-and-back route",
  ]);
}

function toResult(graph, path, lengthM, greenFraction, routeType, warnings) {
  const coords = path.map((n) => {
    const p = graph.nodes.get(n);
    return [p.lat, p.lng];
  });
  return { coords, lengthM, greenFraction, routeType, warnings, pairs: [...edgePairs(path)] };
}

// avoid: Set of edge pair-keys (from previous results' `pairs`) to steer away
// from, so "Alternate route" produces a genuinely different loop.
export function planRoute(graph, lat, lng, targetM, avoid = null) {
  if (graph.nodes.size < 2) {
    throw new NoRouteError("no walkable paths found around the start point");
  }
  const start = nearestNode(graph, lat, lng);
  return findLoop(graph, start, targetM, avoid) ?? findOutAndBack(graph, start, targetM, avoid);
}
