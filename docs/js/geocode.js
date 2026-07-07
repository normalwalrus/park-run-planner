// Free-text address to coordinates via Nominatim — mirrors app/geocode.py.

export async function geocode(address) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`geocoding failed (${response.status})`);
  const results = await response.json();
  if (!results.length) throw new Error(`no results for address: "${address}"`);
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
}
