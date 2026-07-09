import assert from "node:assert/strict";
import { test } from "node:test";

import { inBounds, inSingapore, SG_BOUNDS } from "../../docs/js/geo.js";

test("inBounds contains and rejects for a normal box", () => {
  const uk = [49.9, -8.65, 60.9, 1.8];
  assert.ok(inBounds(51.5074, -0.1278, uk)); // London
  assert.ok(inBounds(60.15, -1.15, uk)); // Lerwick, Shetland
  assert.ok(!inBounds(48.8566, 2.3522, uk)); // Paris: lng east of the box
  assert.ok(!inBounds(43.0, -0.5, uk)); // Pyrenees: lat south of the box
});

test("inBounds handles antimeridian-crossing boxes (west > east)", () => {
  const fiji = [-21.05, 176.8, -12.46, -178.2];
  assert.ok(inBounds(-17.7, 179.5, fiji)); // east of 180
  assert.ok(inBounds(-17.7, -179.5, fiji)); // west of 180
  assert.ok(!inBounds(-17.7, 170.0, fiji)); // west of the box
  assert.ok(!inBounds(-25.0, 179.5, fiji)); // right lng, lat too far south
});

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
