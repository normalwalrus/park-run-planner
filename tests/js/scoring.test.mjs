import assert from "node:assert/strict";
import { test } from "node:test";

import {
  edgeFactor,
  GREEN_FACTOR,
  NEUTRAL_FACTOR,
  ROAD_FACTOR,
} from "../../docs/js/scoring.js";

test("green highway tags", () => {
  for (const highway of ["footway", "path", "cycleway", "pedestrian", "track"]) {
    assert.equal(edgeFactor({ highway }), GREEN_FACTOR);
  }
});

test("park connector names are green", () => {
  assert.equal(
    edgeFactor({ highway: "residential", name: "Kallang Park Connector" }),
    GREEN_FACTOR
  );
  assert.equal(edgeFactor({ highway: "residential", name: "PCN" }), GREEN_FACTOR);
});

test("in-park edges are green", () => {
  assert.equal(edgeFactor({ highway: "residential", inPark: true }), GREEN_FACTOR);
});

test("big roads penalized", () => {
  for (const highway of ["primary", "secondary_link", "trunk", "motorway", "motorway_link"]) {
    assert.equal(edgeFactor({ highway }), ROAD_FACTOR);
  }
});

test("neutral and missing tags", () => {
  assert.equal(edgeFactor({ highway: "residential" }), NEUTRAL_FACTOR);
  assert.equal(edgeFactor({}), NEUTRAL_FACTOR);
});

test("nearWater flag is green", () => {
  assert.equal(edgeFactor({ highway: "residential", nearWater: true }), GREEN_FACTOR);
});
