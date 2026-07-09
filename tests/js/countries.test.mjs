import assert from "node:assert/strict";
import { test } from "node:test";

import { COUNTRIES, countryByCode, detectCountry } from "../../docs/js/countries.js";
import { SG_BOUNDS } from "../../docs/js/geo.js";

test("covers the world and keeps Singapore's historical bounds exactly", () => {
  assert.ok(COUNTRIES.length >= 190);
  assert.deepEqual(countryByCode("SG").bbox, SG_BOUNDS);
});

test("codes are unique, valid ISO2, and lookup is case-insensitive", () => {
  const codes = COUNTRIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((code) => /^[A-Z]{2}$/.test(code)));
  assert.equal(countryByCode("gb").name, "United Kingdom");
  assert.equal(countryByCode("ZZ"), null);
  assert.equal(countryByCode(null), null);
});

test("every bbox is well-formed", () => {
  for (const { code, bbox } of COUNTRIES) {
    const [south, west, north, east] = bbox;
    assert.ok(south < north, `${code}: south >= north`);
    assert.ok(south >= -90 && north <= 90, `${code}: lat out of range`);
    assert.ok(west >= -180 && west <= 180 && east >= -180 && east <= 180, `${code}: lng out of range`);
  }
});

test("detectCountry picks the smallest containing country", () => {
  // Malaysia's and Indonesia's boxes contain Singapore; smallest-area wins.
  assert.equal(detectCountry(1.35, 103.82).code, "SG");
  assert.equal(detectCountry(51.5074, -0.1278).code, "GB");
  assert.equal(detectCountry(48.8566, 2.3522).code, "FR");
});

test("detectCountry works across the antimeridian and fails cleanly at sea", () => {
  assert.equal(detectCountry(-17.7, 179.9).code, "FJ");
  assert.equal(detectCountry(-17.7, -179.5).code, "FJ");
  assert.equal(detectCountry(0, -140), null); // mid-Pacific
});
