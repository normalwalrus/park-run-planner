import assert from "node:assert/strict";
import { test } from "node:test";

import { planRoute, shortestPath, NoRouteError, RELAXED_TOLERANCE } from "../../docs/js/loop.js";
import { edgeFactor, roadLevel, GREEN_FACTOR } from "../../docs/js/scoring.js";

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
  const edge = {
    length,
    w: length * factor,
    green: factor === GREEN_FACTOR,
    road: roadLevel(highway),
  };
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
  assert.equal(route.roadsCrossed, 0); // running along a street is not a crossing
});

// A footway that cuts across a residential road at X, and a slightly longer
// footway detour via Y that avoids the crossing entirely.
function crossingGraph() {
  const graph = makeGraph();
  addNode(graph, "A", CENTER);
  addNode(graph, "X", offset(...CENTER, 0, 100));
  addNode(graph, "B", offset(...CENTER, 0, 200));
  addNode(graph, "Y", offset(...CENTER, 30, 100)); // shallow detour, no sharp turns
  addNode(graph, "R1", offset(...CENTER, 50, 100));
  addNode(graph, "R2", offset(...CENTER, -50, 100));
  connect(graph, "A", "X", 100, "footway");
  connect(graph, "X", "B", 100, "footway");
  connect(graph, "A", "Y", 110, "footway");
  connect(graph, "Y", "B", 110, "footway");
  connect(graph, "R1", "X", 50, "residential"); // the road runs through X
  connect(graph, "X", "R2", 50, "residential");
  return graph;
}

test("crossing penalty prefers a detour over cutting across a road", () => {
  // direct: 200m footway (w=80) + minor crossing (60) = 140; detour: 220m (w=88)
  const path = shortestPath(crossingGraph(), "A", "B");
  assert.deepEqual(path, ["A", "Y", "B"]);
});

test("every road crossing is counted", () => {
  const graph = makeGraph();
  const chain = [
    ["A", 0], ["X1", 100], ["X2", 120], ["X3", 220], ["B", 320],
  ];
  for (const [id, east] of chain) addNode(graph, id, offset(...CENTER, 0, east));
  connect(graph, "A", "X1", 100, "footway");
  connect(graph, "X1", "X2", 20, "footway");
  connect(graph, "X2", "X3", 100, "footway");
  connect(graph, "X3", "B", 100, "footway");
  // road stubs mark X1, X2, and X3 as roads cutting across the footway;
  // X1/X2 are only 20 m apart but each still counts
  for (const [i, x] of ["X1", "X2", "X3"].entries()) {
    addNode(graph, `s${i}`, offset(...CENTER, 30, 100 + i * 10));
    connect(graph, x, `s${i}`, 30, "residential");
  }
  const route = planRoute(graph, ...CENTER, 320, null, "straight");
  assert.equal(route.roadsCrossed, 3);
});

// Two ways from A to B: a short path over a hill vs a longer flat detour.
function hillGraph() {
  const graph = makeGraph();
  addNode(graph, "A", CENTER);
  addNode(graph, "B", offset(...CENTER, 0, 300));
  addNode(graph, "h1", offset(...CENTER, 0, 150)); // on the hill
  addNode(graph, "f1", offset(...CENTER, 30, 100)); // shallow flat detour
  addNode(graph, "f2", offset(...CENTER, 30, 200));
  connect(graph, "A", "h1", 100, "footway");
  connect(graph, "h1", "B", 100, "footway");
  connect(graph, "A", "f1", 110, "footway");
  connect(graph, "f1", "f2", 110, "footway");
  connect(graph, "f2", "B", 110, "footway");
  graph.elev = new Map([["A", 0], ["B", 0], ["h1", 15], ["f1", 0], ["f2", 0]]);
  return graph;
}

test("elevation 'none' avoids the hill, 'high' seeks it", () => {
  // hill: 200m green (w=80) + 15m climb; flat: 330m green (w=132)
  const flat = shortestPath(hillGraph(), "A", "B", null, null, "none");
  assert.deepEqual(flat, ["A", "f1", "f2", "B"]); // 10/m * 15m climbed pushes off the hill
  const hilly = shortestPath(hillGraph(), "A", "B", null, null, "high");
  assert.deepEqual(hilly, ["A", "h1", "B"]); // climbing edges discounted
});

test("elevation gain is reported, null without data", () => {
  const graph = hillGraph();
  const route = planRoute(graph, ...CENTER, 300, null, "straight", "low");
  assert.ok(route.elevationGain !== null);
  const noData = hillGraph();
  delete noData.elev;
  const route2 = planRoute(noData, ...CENTER, 300, null, "straight", "low");
  assert.equal(route2.elevationGain, null);
});

// A short direct street A->B vs a green detour three times as long.
function stayForkGraph() {
  const graph = makeGraph();
  addNode(graph, "A", CENTER);
  addNode(graph, "B", offset(...CENTER, 0, 300));
  addNode(graph, "d1", offset(...CENTER, 60, 100)); // shallow green detour
  addNode(graph, "d2", offset(...CENTER, 60, 200));
  connect(graph, "A", "B", 300, "residential");
  connect(graph, "A", "d1", 300, "footway");
  connect(graph, "d1", "d2", 300, "footway");
  connect(graph, "d2", "B", 300, "footway");
  return graph;
}

test("stay prefers a much longer green path", () => {
  // street 300 (w=300) vs green 900 (w=360): normally the street wins, but
  // with stay the street costs 300 x 4 = 1200 and the green detour wins.
  const direct = shortestPath(stayForkGraph(), "A", "B", null, null, "low", false);
  assert.deepEqual(direct, ["A", "B"]);
  const green = shortestPath(stayForkGraph(), "A", "B", null, null, "low", true);
  assert.deepEqual(green, ["A", "d1", "d2", "B"]);
});

test("stay warns when streets are unavoidable", () => {
  const route = planRoute(lineGraph(), ...CENTER, 2000, null, "straight", "low", true);
  assert.ok(route.warnings.some((w) => w.includes("where possible")));
  const without = planRoute(lineGraph(), ...CENTER, 2000, null, "straight", "low", false);
  assert.ok(!without.warnings.some((w) => w.includes("where possible")));
});

test("sights on the route are reported, far ones ignored", () => {
  const graph = ringGraph();
  const node0 = graph.nodes.get(0); // on the ring
  graph.sights = [
    { name: "Lookout", lat: node0.lat, lng: node0.lng },
    { name: "Far Museum", lat: node0.lat + 0.1, lng: node0.lng },
  ];
  const route = planRoute(graph, ...CENTER, 3300);
  assert.deepEqual(route.sights.map((s) => s.name), ["Lookout"]);
});

// Two green chains from A: east to B1 (400 m, on target) and north to B2
// (404 m, slightly off target) passing a sight at q1.
function sightForkGraph() {
  const graph = makeGraph();
  addNode(graph, "A", CENTER);
  addNode(graph, "p1", offset(...CENTER, 0, 100));
  addNode(graph, "p2", offset(...CENTER, 0, 200));
  addNode(graph, "B1", offset(...CENTER, 0, 400));
  addNode(graph, "q1", offset(...CENTER, 100, 0));
  addNode(graph, "q2", offset(...CENTER, 200, 0));
  addNode(graph, "B2", offset(...CENTER, 404, 0));
  connect(graph, "A", "p1", 100, "footway");
  connect(graph, "p1", "p2", 100, "footway");
  connect(graph, "p2", "B1", 200, "footway");
  connect(graph, "A", "q1", 100, "footway");
  connect(graph, "q1", "q2", 100, "footway");
  connect(graph, "q2", "B2", 204, "footway");
  return graph;
}

test("sight bonus tips the route toward a sight only when enabled", () => {
  // With the preference on, a sight on the 404 m chain outweighs its 1%
  // deviation (+0.05 bonus vs -0.02 score); off (the default), the on-target
  // 400 m chain wins even though the sight is there.
  const scenicGraph = sightForkGraph();
  const q1 = scenicGraph.nodes.get("q1");
  scenicGraph.sights = [{ name: "Heritage Tree", lat: q1.lat, lng: q1.lng }];
  const byDefault = planRoute(scenicGraph, ...CENTER, 400, null, "straight");
  assert.ok(Math.abs(byDefault.lengthM - 400) < 1e-6);
  const scenic = planRoute(scenicGraph, ...CENTER, 400, null, "straight", "low", false, true);
  assert.ok(Math.abs(scenic.lengthM - 404) < 1e-6);
  assert.deepEqual(scenic.sights.map((s) => s.name), ["Heritage Tree"]);
});

test("elevation gain is the largest single climb, not the total", () => {
  // Two hills along the line: 12 m then 6 m — report the biggest climb (12),
  // not the total ascent (18).
  const graph = lineGraph(100, 5);
  graph.elev = new Map([[0, 0], [1, 12], [2, 3], [3, 9], [4, 0]]);
  const route = planRoute(graph, ...CENTER, 400, null, "straight", "low");
  assert.equal(route.elevationGain, 12);
});

// Two ways from A to B: a zigzag that is shorter on paper and a straight chain
// that is slightly longer. Turn penalties must favor the straight one.
function zigzagGraph() {
  const graph = makeGraph();
  addNode(graph, "A", CENTER);
  addNode(graph, "B", offset(...CENTER, 0, 400));
  // straight chain, 4 edges, weighted length 110 each = 440
  const straight = ["s1", "s2", "s3"];
  straight.forEach((id, i) => addNode(graph, id, offset(...CENTER, 0, 100 * (i + 1))));
  const chain = ["A", ...straight, "B"];
  for (let i = 1; i < chain.length; i++) connect(graph, chain[i - 1], chain[i], 110, "residential");
  // zigzag E,N,E,S,…: 8 edges with 7 right-angle turns, length 50 each = 400
  const zig = [
    [0, 100], [100, 100], [100, 200], [0, 200], [0, 300], [100, 300], [100, 400],
  ].map(([n, e], i) => {
    const id = `z${i}`;
    addNode(graph, id, offset(...CENTER, n, e));
    return id;
  });
  const zchain = ["A", ...zig, "B"];
  for (let i = 1; i < zchain.length; i++) connect(graph, zchain[i - 1], zchain[i], 50, "residential");
  return graph;
}

test("turn penalties prefer the straight chain over a shorter zigzag", () => {
  const path = shortestPath(zigzagGraph(), "A", "B");
  assert.deepEqual(path, ["A", "s1", "s2", "s3", "B"]);
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
