// Small geographic helpers shared by the routing modules.

export const METERS_PER_DEG_LAT = 111320;

// Singapore bounding box: [south, west, north, east].
export const SG_BOUNDS = [1.13, 103.6, 1.47, 104.1];

export function inSingapore(lat, lng) {
  const [south, west, north, east] = SG_BOUNDS;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

export function haversineM(a, b) {
  const rad = Math.PI / 180;
  const [lat1, lng1] = [a[0] * rad, a[1] * rad];
  const [lat2, lng2] = [b[0] * rad, b[1] * rad];
  const h =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

export function project(lat, lng, bearingDeg, distM) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / METERS_PER_DEG_LAT;
  const dLng =
    (distM * Math.sin(rad)) / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}

// Ray-casting point-in-polygon; ring is [[lat, lng], ...].
export function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    if (
      latI > lat !== latJ > lat &&
      lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI
    ) {
      inside = !inside;
    }
  }
  return inside;
}
