// Free-text address to coordinates via Nominatim, restricted to Singapore —
// mirrors app/geocode.py.

import { SG_BOUNDS } from "./geo.js";

export async function geocode(address) {
  const [south, west, north, east] = SG_BOUNDS;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "sg");
  url.searchParams.set("viewbox", `${west},${south},${east},${north}`);
  url.searchParams.set("bounded", "1");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`geocoding failed (${response.status})`);
  const results = await response.json();
  if (!results.length) throw new Error(`no results in Singapore for: "${address}"`);
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
}
