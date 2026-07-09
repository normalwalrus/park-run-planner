import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseResults,
  parsePhoton,
  mergeSuggestions,
  search,
  geocode,
  MAX_SUGGESTIONS,
} from "../../docs/js/geocode.js";
import { countryByCode } from "../../docs/js/countries.js";

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

const PHOTON_PAYLOAD = {
  features: [
    {
      geometry: { coordinates: [-0.1657, 51.5073] },
      properties: { name: "Hyde Park", countrycode: "GB", city: "London", state: "England" },
    },
    {
      // wrong country — dropped despite Photon returning it
      geometry: { coordinates: [-73.9665, 40.7812] },
      properties: { name: "Central Park", countrycode: "US", city: "New York" },
    },
    {
      // no name: falls back to street + housenumber
      geometry: { coordinates: [-0.15, 51.5] },
      properties: {
        street: "Serpentine Road",
        housenumber: "1",
        countrycode: "GB",
        city: "London",
      },
    },
    {
      // exact duplicate of the first — dropped
      geometry: { coordinates: [-0.1657, 51.5073] },
      properties: { name: "Hyde Park", countrycode: "GB", city: "London", state: "England" },
    },
  ],
};

test("parsePhoton filters by country, maps lon/lat, and dedupes", () => {
  const parsed = parsePhoton(PHOTON_PAYLOAD, "GB");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Hyde Park");
  assert.equal(parsed[0].address, "London, England");
  assert.equal(parsed[0].lat, 51.5073);
  assert.equal(parsed[0].lng, -0.1657);
  assert.equal(parsed[1].name, "Serpentine Road 1"); // street fallback, not repeated in address
  assert.equal(parsed[1].address, "London");
});

test("parsePhoton respects the limit", () => {
  const many = {
    features: Array.from({ length: 20 }, (_, i) => ({
      geometry: { coordinates: [i * 0.01, 51.5] },
      properties: { name: `Place ${i}`, countrycode: "GB" },
    })),
  };
  assert.equal(parsePhoton(many, "GB").length, MAX_SUGGESTIONS);
});

async function withFetch(stub, run) {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url) => {
    urls.push(new URL(url));
    return Promise.resolve({ ok: true, json: async () => stub });
  };
  try {
    return [await run(), urls];
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("search routes Singapore to OneMap and elsewhere to Photon", async () => {
  const [, sgUrls] = await withFetch({ results: [] }, () => search("bishan"));
  assert.equal(sgUrls[0].hostname, "www.onemap.gov.sg");

  const gb = countryByCode("GB");
  const [results, gbUrls] = await withFetch(PHOTON_PAYLOAD, () => search("hyde park", gb));
  assert.equal(gbUrls[0].hostname, "photon.komoot.io");
  assert.equal(gbUrls[0].searchParams.get("q"), "hyde park");
  assert.equal(gbUrls[0].searchParams.get("lang"), "en");
  assert.ok(gbUrls[0].searchParams.get("bbox").startsWith("-8.65,49.9"));
  assert.ok(results.every((r) => r.name !== "Central Park")); // US feature filtered
});

test("search skips the bbox param for antimeridian-crossing countries", async () => {
  const fj = countryByCode("FJ");
  const [, urls] = await withFetch({ features: [] }, () => search("suva", fj));
  assert.equal(urls[0].searchParams.get("bbox"), null);
  const lon = parseFloat(urls[0].searchParams.get("lon"));
  assert.ok(Math.abs(lon) > 170, `bias lon should be near 180, got ${lon}`); // not the Gulf of Guinea
});

test("geocode names the country in its no-results error", async () => {
  await assert.rejects(
    withFetch({ features: [] }, () => geocode("nowhere", countryByCode("GB"))),
    /no results in United Kingdom/
  );
});
