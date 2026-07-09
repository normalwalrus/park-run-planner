// Place search: OneMap for Singapore (mirrors app/geocode.py), Photon for
// every other country. The Photon side deliberately has no Python mirror —
// the FastAPI backend stays Singapore-only.

import { inSingapore } from "./geo.js";
import { countryByCode } from "./countries.js";

const ONEMAP_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const PHOTON_URL = "https://photon.komoot.io/api";
export const MAX_SUGGESTIONS = 6;

function titleCase(text) {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Parse a OneMap elastic-search payload into suggestion objects.
export function parseResults(data, limit = MAX_SUGGESTIONS) {
  const seen = new Set();
  const out = [];
  for (const r of data.results ?? []) {
    const lat = parseFloat(r.LATITUDE);
    const lng = parseFloat(r.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inSingapore(lat, lng)) continue;
    const name = titleCase(r.SEARCHVAL ?? "");
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const address = r.ADDRESS && r.ADDRESS !== "NIL" ? titleCase(r.ADDRESS) : "";
    out.push({ name, address, lat, lng });
    if (out.length >= limit) break;
  }
  return out;
}

// Parse a Photon (GeoJSON) payload into suggestion objects, keeping only
// features in the requested country — Photon's own bbox filter can't be
// trusted near the antimeridian, so the countrycode check is the real gate.
export function parsePhoton(data, countryCode, limit = MAX_SUGGESTIONS) {
  const seen = new Set();
  const out = [];
  for (const feature of data.features ?? []) {
    const props = feature.properties ?? {};
    if (props.countrycode !== countryCode) continue;
    const [lng, lat] = feature.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const street = [props.street, props.housenumber].filter(Boolean).join(" ");
    const name = props.name || street;
    if (!name) continue;
    const address = [name === street ? "" : street, props.district, props.city, props.state]
      .filter(Boolean)
      .join(", ");
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, address, lat, lng });
    if (out.length >= limit) break;
  }
  return out;
}

// Curated spots first (when they match the query), then provider results.
export function mergeSuggestions(spots, results, query, limit = MAX_SUGGESTIONS) {
  const wanted = query.trim().toLowerCase();
  const curated = spots
    .filter((s) => s.name.toLowerCase().includes(wanted))
    .map((s) => ({ ...s, address: "Popular running spot" }));
  const names = new Set(curated.map((s) => s.name.toLowerCase()));
  const rest = results.filter((r) => !names.has(r.name.toLowerCase()));
  return [...curated, ...rest].slice(0, limit);
}

async function oneMapSearch(query) {
  const url = new URL(ONEMAP_URL);
  url.searchParams.set("searchVal", query);
  url.searchParams.set("returnGeom", "Y");
  url.searchParams.set("getAddrDetails", "Y");
  url.searchParams.set("pageNum", "1");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`address search failed (${response.status})`);
  return parseResults(await response.json());
}

async function photonSearch(query, country) {
  const [south, west, north, east] = country.bbox;
  const width = west <= east ? east - west : east - west + 360;
  let centerLng = west + width / 2;
  if (centerLng > 180) centerLng -= 360;
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", query);
  // Over-fetch: the countrycode filter below throws away neighbours.
  url.searchParams.set("limit", "15");
  url.searchParams.set("lang", "en");
  url.searchParams.set("lat", ((south + north) / 2).toFixed(3));
  url.searchParams.set("lon", centerLng.toFixed(3));
  url.searchParams.set("location_bias_scale", "0.2");
  // Photon mishandles boxes that cross the antimeridian (west > east) —
  // skip the param for those and rely on the countrycode filter alone.
  if (west <= east) url.searchParams.set("bbox", `${west},${south},${east},${north}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`address search failed (${response.status})`);
  return parsePhoton(await response.json(), country.code);
}

export async function search(query, country = countryByCode("SG")) {
  return country.code === "SG" ? oneMapSearch(query) : photonSearch(query, country);
}

// Top match for non-interactive lookups (deep links).
export async function geocode(query, country = countryByCode("SG")) {
  const results = await search(query, country);
  if (!results.length) throw new Error(`no results in ${country.name} for: "${query}"`);
  return results[0];
}
