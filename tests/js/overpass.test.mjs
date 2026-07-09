import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGraph, loadGraph, radiusFor } from "../../docs/js/overpass.js";
import { pointInRing } from "../../docs/js/geo.js";

test("radius scales with distance and clamps", () => {
  assert.equal(radiusFor(1000), 1000);
  assert.ok(radiusFor(5000) > 2000 && radiusFor(5000) < 3000);
  assert.equal(radiusFor(30000), 6000);
});

test("point in ring", () => {
  const ring = [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]];
  assert.ok(pointInRing(1, 1, ring));
  assert.ok(!pointInRing(3, 1, ring));
});

test("buildGraph drops disconnected fragments", () => {
  const elements = [
    {
      type: "way",
      nodes: [1, 2, 3],
      geometry: [
        { lat: 1.35, lon: 103.8 },
        { lat: 1.35, lon: 103.801 },
        { lat: 1.35, lon: 103.802 },
      ],
      tags: { highway: "footway" },
    },
    {
      // isolated two-node stub far from the main component
      type: "way",
      nodes: [90, 91],
      geometry: [
        { lat: 1.36, lon: 103.81 },
        { lat: 1.36, lon: 103.8101 },
      ],
      tags: { highway: "footway" },
    },
  ];
  const graph = buildGraph(elements);
  assert.deepEqual([...graph.nodes.keys()].sort(), [1, 2, 3]);
  assert.ok(!graph.adj.has(90));
});

test("buildGraph wires edges, greenness, and park overlap", () => {
  const elements = [
    {
      type: "way",
      nodes: [1, 2, 3],
      geometry: [
        { lat: 1.0, lon: 103.0 },
        { lat: 1.0, lon: 103.001 },
        { lat: 1.0, lon: 103.002 },
      ],
      tags: { highway: "footway" },
    },
    {
      type: "way",
      nodes: [3, 4],
      geometry: [
        { lat: 1.0, lon: 103.002 },
        { lat: 1.0, lon: 103.003 },
      ],
      tags: { highway: "residential" },
    },
    {
      // residential street inside a park polygon -> green via inPark
      type: "way",
      nodes: [4, 5],
      geometry: [
        { lat: 1.0, lon: 103.003 },
        { lat: 1.0, lon: 103.004 },
      ],
      tags: { highway: "residential" },
    },
    {
      type: "way",
      nodes: [10, 11, 12, 13, 10],
      geometry: [
        { lat: 0.999, lon: 103.0028 },
        { lat: 1.001, lon: 103.0028 },
        { lat: 1.001, lon: 103.0045 },
        { lat: 0.999, lon: 103.0045 },
        { lat: 0.999, lon: 103.0028 },
      ],
      tags: { leisure: "park" },
    },
  ];
  const graph = buildGraph(elements);
  assert.equal(graph.nodes.size, 5);
  const footway = graph.adj.get(1)[0];
  assert.ok(footway.green);
  assert.ok(Math.abs(footway.length - 111.3) < 1);
  const street = graph.adj.get(3).find((e) => e.to === 4);
  assert.ok(!street.green); // midpoint 103.0025 is west of the park polygon
  const inParkStreet = graph.adj.get(4).find((e) => e.to === 5);
  assert.ok(inParkStreet.green); // midpoint 103.0035 lies inside the park polygon
});

test("edges near a river are marked green, distant ones are not", () => {
  const elements = [
    {
      // river running west-east at lat 1.35
      type: "way",
      nodes: [50, 51],
      geometry: [
        { lat: 1.35, lon: 103.8 },
        { lat: 1.35, lon: 103.804 },
      ],
      tags: { waterway: "river" },
    },
    {
      // residential chain: first segment ~20 m from the river, then bending far north
      type: "way",
      nodes: [1, 2, 3],
      geometry: [
        { lat: 1.35018, lon: 103.8 },
        { lat: 1.35018, lon: 103.802 },
        { lat: 1.354, lon: 103.802 },
      ],
      tags: { highway: "residential" },
    },
  ];
  const graph = buildGraph(elements);
  const nearEdge = graph.adj.get(1).find((e) => e.to === 2);
  const farEdge = graph.adj.get(3).find((e) => e.to === 2);
  assert.equal(nearEdge.green, true); // waterside street counts as green
  assert.equal(farEdge.green, false);
});

test("waterside detection keeps its width at high latitudes", () => {
  // At 60°N a longitude degree is only ~55.7 km, so a 40 m corridor needs a
  // wider east-west bbox margin than at the equator.
  const elements = [
    {
      // river running west-east at lat 60
      type: "way",
      nodes: [50, 51],
      geometry: [
        { lat: 60.0, lon: 10.0 },
        { lat: 60.0, lon: 10.004 },
      ],
      tags: { waterway: "river" },
    },
    {
      // residential chain heading east: first segment ~30 m past the river's
      // end, the last ~70 m past it
      type: "way",
      nodes: [1, 2, 3, 4],
      geometry: [
        { lat: 60.0, lon: 10.0045 },
        { lat: 60.0, lon: 10.00458 },
        { lat: 60.0, lon: 10.0052 },
        { lat: 60.0, lon: 10.00528 },
      ],
      tags: { highway: "residential" },
    },
  ];
  const graph = buildGraph(elements);
  const nearEdge = graph.adj.get(1).find((e) => e.to === 2);
  const farEdge = graph.adj.get(4).find((e) => e.to === 3);
  assert.equal(nearEdge.green, true); // ~30 m east of the water
  assert.equal(farEdge.green, false); // ~70 m east of the water
});

test("loadGraph fails over to the next mirror when the first errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url) => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("connection refused"));
    return Promise.resolve({ ok: true, json: async () => ({ elements: [] }) });
  };
  try {
    const graph = await loadGraph(1.3, 103.8, 1000);
    assert.ok(graph.nodes instanceof Map);
    assert.equal(calls, 2); // second mirror answered
  } finally {
    globalThis.fetch = originalFetch;
  }
});
