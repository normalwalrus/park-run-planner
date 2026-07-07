import assert from "node:assert/strict";
import { test } from "node:test";

import { planRoute, NoRouteError, RELAXED_TOLERANCE } from "../../docs/js/loop.js";
import { edgeFactor, GREEN_FACTOR } from "../../docs/js/scoring.js";

const CENTER = [1.0, 103.0];
const M_PER_DEG = 111320;

function offset(lat, lng, northM, eastM) {
  return [
    lat + northM / M_PER_DEG,
    lng + eastM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)),
  ];
}

function makeGraph() {
  return { nodes: new Map(), adj: new Map() };
}

function addNode(graph, id, [lat, lng]) {
  graph.nodes.set(id, { lat, lng });
  graph.adj.set(id, []);
}

function connect(graph, u, v, length, highway) {
  const factor = edgeFactor({ highway });
  const edge = { length, w: length * factor, green: factor === GREEN_FACTOR };
  graph.adj.get(u).push({ to: v, ...edge });
  graph.adj.get(v).push({ to: u, ...edge });
}

// A green ring around a center node, joined by one neutral spoke.
function ringGraph(radiusM = 400, n = 36) {
  const graph = makeGraph();
  addNode(graph, "start", CENTER);
  for (let i = 0; i < n; i++) {
    const bearing = (2 * Math.PI * i) / n;
    addNode(
      graph,
      i,
      offset(...CENTER, radiusM * Math.cos(bearing), radiusM * Math.sin(bearing))
    );
  }
  const arc = (2 * Math.PI * radiusM) / n;
  for (let i = 0; i < n; i++) connect(graph, i, (i + 1) % n, arc, "footway");
  connect(graph, "start", 0, radiusM, "residential");
  return graph;
}

// A straight neutral path east of the center; no loops exist.
function lineGraph(spacingM = 100, n = 21) {
  const graph = makeGraph();
  for (let i = 0; i < n; i++) addNode(graph, i, offset(...CENTER, 0, spacingM * i));
  for (let i = 0; i < n - 1; i++) connect(graph, i, i + 1, spacingM, "residential");
  return graph;
}

test("finds a loop of roughly the target length", () => {
  const target = 3300; // ~ring circumference (2513) + spoke out and back (800)
  const route = planRoute(ringGraph(), ...CENTER, target);
  assert.equal(route.routeType, "loop");
  assert.ok(Math.abs(route.lengthM - target) / target <= RELAXED_TOLERANCE);
  assert.deepEqual(route.coords[0], route.coords[route.coords.length - 1]);
});

test("loop prefers green edges", () => {
  const route = planRoute(ringGraph(), ...CENTER, 3300);
  assert.ok(route.greenFraction > 0.7);
});

test("out-and-back fallback on a line", () => {
  const route = planRoute(lineGraph(), ...CENTER, 3000);
  assert.equal(route.routeType, "out_and_back");
  assert.ok(Math.abs(route.lengthM - 3000) < 1e-6);
  assert.deepEqual(route.coords[0], route.coords[route.coords.length - 1]);
  assert.ok(route.warnings.length > 0);
});

test("empty graph raises", () => {
  assert.throws(() => planRoute(makeGraph(), ...CENTER, 3000), NoRouteError);
});

// A street grid: many distinct loops of the same length exist.
function gridGraph(spacingM = 150, n = 5) {
  const graph = makeGraph();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      addNode(graph, `${i},${j}`, offset(...CENTER, spacingM * j, spacingM * i));
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) connect(graph, `${i},${j}`, `${i + 1},${j}`, spacingM, "residential");
      if (j + 1 < n) connect(graph, `${i},${j}`, `${i},${j + 1}`, spacingM, "residential");
    }
  }
  return graph;
}

test("straight shape gives a one-way route of the full distance", () => {
  const graph = lineGraph(); // 2 km straight path, nodes every 100 m
  const route = planRoute(graph, ...CENTER, 1500, null, "straight");
  assert.equal(route.routeType, "one_way");
  assert.ok(Math.abs(route.lengthM - 1500) < 1e-6);
  assert.notDeepEqual(route.coords[0], route.coords[route.coords.length - 1]);
  assert.equal(route.warnings.length, 0);
});

test("straight shape warns when the network is too small for the distance", () => {
  const route = planRoute(lineGraph(), ...CENTER, 10000, null, "straight");
  assert.equal(route.routeType, "one_way");
  assert.ok(route.lengthM <= 2000);
  assert.ok(route.warnings[0].includes("closest straight route"));
});

test("avoiding a route's edges yields a different alternate route", () => {
  const graph = gridGraph();
  const first = planRoute(graph, ...CENTER, 1800);
  assert.ok(first.pairs.length > 0);
  const second = planRoute(graph, ...CENTER, 1800, new Set(first.pairs));
  assert.notEqual(JSON.stringify(first.coords), JSON.stringify(second.coords));
  assert.deepEqual(second.coords[0], second.coords[second.coords.length - 1]);
});
