import assert from "node:assert/strict";
import { test } from "node:test";

import { tileCoords, decodeTerrarium, TILE_ZOOM } from "../../docs/js/elevation.js";

test("terrarium decoding", () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0); // 128*256 - 32768
  assert.equal(decodeTerrarium(128, 100, 0), 100);
  assert.ok(Math.abs(decodeTerrarium(128, 0, 128) - 0.5) < 1e-9);
});

test("tile coords for Singapore land inside the expected tile", () => {
  const { x, y } = tileCoords(1.3521, 103.8198);
  assert.equal(TILE_ZOOM, 13);
  assert.equal(Math.floor(x), 6458); // (103.8198+180)/360 * 8192
  assert.equal(Math.floor(y), 4065);
  assert.ok(x > Math.floor(x) && y > Math.floor(y)); // fractional pixel position
});
