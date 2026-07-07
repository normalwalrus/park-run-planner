import assert from "node:assert/strict";
import { test } from "node:test";

import { inSingapore, SG_BOUNDS } from "../../docs/js/geo.js";

test("singapore locations are inside the bounds", () => {
  assert.ok(inSingapore(1.3521, 103.8198)); // central Singapore
  assert.ok(inSingapore(1.3008, 103.9122)); // East Coast Park
});

test("foreign locations are outside the bounds", () => {
  assert.ok(!inSingapore(51.5074, -0.1278)); // London
  assert.ok(!inSingapore(1.4927, 103.7414)); // Johor Bahru, across the strait
});

test("bounds are ordered south, west, north, east", () => {
  const [south, west, north, east] = SG_BOUNDS;
  assert.ok(south < north && west < east);
});
