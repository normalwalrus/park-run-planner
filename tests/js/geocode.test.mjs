import assert from "node:assert/strict";
import { test } from "node:test";

import { parseResults, mergeSuggestions, MAX_SUGGESTIONS } from "../../docs/js/geocode.js";

const ONEMAP_PAYLOAD = {
  results: [
    {
      SEARCHVAL: "EAST COAST PARK",
      ADDRESS: "38 THIRD STREET EAST COAST PARK SINGAPORE 455513",
      LATITUDE: "1.31326624037145",
      LONGITUDE: "103.924568894436",
    },
    {
      // duplicate name — dropped
      SEARCHVAL: "EAST COAST PARK",
      ADDRESS: "OTHER ENTRANCE",
      LATITUDE: "1.3011",
      LONGITUDE: "103.9155",
    },
    {
      // outside Singapore — dropped
      SEARCHVAL: "JOHOR SPOT",
      ADDRESS: "ACROSS THE STRAIT",
      LATITUDE: "1.4927",
      LONGITUDE: "103.7414",
    },
    {
      SEARCHVAL: "406 ANG MO KIO AVENUE 10 SINGAPORE 560406",
      ADDRESS: "NIL",
      LATITUDE: "1.362",
      LONGITUDE: "103.8539",
    },
  ],
};

test("parseResults filters, dedupes, and title-cases", () => {
  const parsed = parseResults(ONEMAP_PAYLOAD);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "East Coast Park");
  assert.equal(parsed[0].address, "38 Third Street East Coast Park Singapore 455513");
  assert.equal(parsed[1].address, ""); // NIL address hidden
  assert.ok(parsed.every((s) => typeof s.lat === "number" && typeof s.lng === "number"));
});

test("parseResults respects the limit", () => {
  const many = {
    results: Array.from({ length: 20 }, (_, i) => ({
      SEARCHVAL: `PLACE ${i}`,
      ADDRESS: "SOMEWHERE",
      LATITUDE: "1.35",
      LONGITUDE: "103.8",
    })),
  };
  assert.equal(parseResults(many).length, MAX_SUGGESTIONS);
});

test("mergeSuggestions ranks matching curated spots first and dedupes", () => {
  const spots = [{ name: "East Coast Park", lat: 1.3008, lng: 103.9122 }];
  const results = parseResults(ONEMAP_PAYLOAD);
  const merged = mergeSuggestions(spots, results, "east coast");
  assert.equal(merged[0].name, "East Coast Park");
  assert.equal(merged[0].address, "Popular running spot");
  assert.equal(merged[0].lat, 1.3008); // curated coords win over OneMap's
  assert.equal(merged.filter((s) => s.name === "East Coast Park").length, 1);
});

test("mergeSuggestions passes through when no curated spot matches", () => {
  const spots = [{ name: "West Coast Park", lat: 1.2926, lng: 103.7651 }];
  const merged = mergeSuggestions(spots, parseResults(ONEMAP_PAYLOAD), "560406");
  assert.ok(merged.every((s) => s.address !== "Popular running spot"));
  assert.ok(merged.some((s) => s.name.includes("560406")));
});
