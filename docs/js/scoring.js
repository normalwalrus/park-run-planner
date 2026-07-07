// Park-preferring cost factors — mirrors app/routing/scoring.py.

export const GREEN_FACTOR = 0.4;
export const NEUTRAL_FACTOR = 1.0;
export const ROAD_FACTOR = 2.5;

const GREEN_HIGHWAYS = new Set([
  "footway",
  "path",
  "pedestrian",
  "track",
  "cycleway",
  "bridleway",
]);
const ROAD_HIGHWAYS = new Set([
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "trunk",
  "trunk_link",
]);
const PCN_NAME = /park connector|pcn/i;

export function edgeFactor({ highway, name, inPark }) {
  if (inPark) return GREEN_FACTOR;
  if (name && PCN_NAME.test(name)) return GREEN_FACTOR;
  if (highway && GREEN_HIGHWAYS.has(highway)) return GREEN_FACTOR;
  if (highway && ROAD_HIGHWAYS.has(highway)) return ROAD_FACTOR;
  return NEUTRAL_FACTOR;
}
