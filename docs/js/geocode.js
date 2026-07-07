// Singapore place / address / postal-code search via OneMap — mirrors app/geocode.py.

import { inSingapore } from "./geo.js";

const ONEMAP_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
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

// Curated spots first (when they match the query), then OneMap results.
export function mergeSuggestions(spots, results, query, limit = MAX_SUGGESTIONS) {
  const wanted = query.trim().toLowerCase();
  const curated = spots
    .filter((s) => s.name.toLowerCase().includes(wanted))
    .map((s) => ({ ...s, address: "Popular running spot" }));
  const names = new Set(curated.map((s) => s.name.toLowerCase()));
  const rest = results.filter((r) => !names.has(r.name.toLowerCase()));
  return [...curated, ...rest].slice(0, limit);
}

export async function search(query) {
  const url = new URL(ONEMAP_URL);
  url.searchParams.set("searchVal", query);
  url.searchParams.set("returnGeom", "Y");
  url.searchParams.set("getAddrDetails", "Y");
  url.searchParams.set("pageNum", "1");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`address search failed (${response.status})`);
  return parseResults(await response.json());
}

// Top match for non-interactive lookups (deep links).
export async function geocode(query) {
  const results = await search(query);
  if (!results.length) throw new Error(`no results in Singapore for: "${query}"`);
  return results[0];
}
