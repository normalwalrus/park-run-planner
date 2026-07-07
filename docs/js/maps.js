// Google Maps walking-directions URL from route coordinates — mirrors app/maps.py.

import { haversineM } from "./geo.js";

export const MAX_WAYPOINTS = 9;

export function sampleWaypoints(path, count = MAX_WAYPOINTS) {
  if (path.length <= 2) return [];
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineM(path[i - 1], path[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return [];
  count = Math.min(count, path.length - 2);
  const waypoints = [];
  let idx = 0;
  for (let i = 1; i <= count; i++) {
    const target = (total * i) / (count + 1);
    while (idx < cumulative.length - 1 && cumulative[idx] < target) idx++;
    waypoints.push(path[idx]);
  }
  return waypoints.filter(
    (wp, i) => i === 0 || wp[0] !== waypoints[i - 1][0] || wp[1] !== waypoints[i - 1][1]
  );
}

const fmt = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

export function googleMapsUrl(path) {
  const params = new URLSearchParams({
    api: "1",
    origin: fmt(path[0]),
    destination: fmt(path[path.length - 1]),
    travelmode: "walking",
  });
  const waypoints = sampleWaypoints(path);
  if (waypoints.length) params.set("waypoints", waypoints.map(fmt).join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}
