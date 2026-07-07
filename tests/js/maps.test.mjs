import assert from "node:assert/strict";
import { test } from "node:test";

import { googleMapsUrl, sampleWaypoints, MAX_WAYPOINTS } from "../../docs/js/maps.js";

function ringPath(n = 50) {
  const path = Array.from({ length: n }, (_, i) => [
    1.35 + 0.004 * Math.cos((2 * Math.PI * i) / n),
    103.8 + 0.004 * Math.sin((2 * Math.PI * i) / n),
  ]);
  return [...path, path[0]];
}

test("url structure", () => {
  const url = new URL(googleMapsUrl(ringPath()));
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("origin"), url.searchParams.get("destination"));
});

test("at most nine waypoints", () => {
  const url = new URL(googleMapsUrl(ringPath(200)));
  const waypoints = url.searchParams.get("waypoints").split("|");
  assert.ok(waypoints.length >= 1 && waypoints.length <= MAX_WAYPOINTS);
});

test("waypoints spread along the path in order", () => {
  const path = ringPath();
  const indices = sampleWaypoints(path).map((wp) => path.indexOf(wp));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  assert.equal(new Set(indices).size, indices.length);
});

test("short path has no waypoints", () => {
  const url = new URL(googleMapsUrl([[1.35, 103.8], [1.36, 103.81]]));
  assert.equal(url.searchParams.get("waypoints"), null);
});
