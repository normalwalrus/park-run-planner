// Node elevations from AWS Terrain Tiles (Terrarium encoding) — mirrors the
// elevation annotation in app/routing/graph.py.
//
// elevation_m = (R * 256 + G + B / 256) - 32768, sampled from z13 PNG tiles
// (~19 m/px), which is plenty for run planning and needs only a handful of
// tile fetches per area.

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const TILE_ZOOM = 13;
const TILE_SIZE = 256;

const tileCache = new Map(); // "z/x/y" -> ImageData (or null after a failed fetch)

export function tileCoords(lat, lng, zoom = TILE_ZOOM) {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

async function fetchTile(tx, ty) {
  const key = `${TILE_ZOOM}/${tx}/${ty}`;
  if (tileCache.has(key)) return tileCache.get(key);
  let data = null;
  try {
    const response = await fetch(`${TILE_URL}/${key}.png`);
    if (response.ok) {
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = TILE_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    }
  } catch {
    data = null;
  }
  tileCache.set(key, data);
  return data;
}

// Annotate graph.elev (Map node id -> meters). Returns false when elevation
// data could not be loaded (routes still work, elevation is just ignored).
export async function annotateElevation(graph) {
  const needed = new Set();
  for (const p of graph.nodes.values()) {
    const { x, y } = tileCoords(p.lat, p.lng);
    needed.add(`${Math.floor(x)},${Math.floor(y)}`);
  }
  const tiles = new Map();
  await Promise.all(
    [...needed].map(async (key) => {
      const [tx, ty] = key.split(",").map(Number);
      tiles.set(key, await fetchTile(tx, ty));
    })
  );
  if ([...tiles.values()].every((t) => t === null)) return false;

  graph.elev = new Map();
  for (const [id, p] of graph.nodes) {
    const { x, y } = tileCoords(p.lat, p.lng);
    const tile = tiles.get(`${Math.floor(x)},${Math.floor(y)}`);
    if (!tile) continue;
    graph.elev.set(id, sampleBilinear(tile, (x - Math.floor(x)) * TILE_SIZE, (y - Math.floor(y)) * TILE_SIZE));
  }
  return true;
}

// Bilinear sampling smooths pixel-quantization jitter, which otherwise fakes
// climbs between closely spaced graph nodes (clamped at tile edges).
function sampleBilinear(tile, fx, fy) {
  const clamp = (v) => Math.min(TILE_SIZE - 1, Math.max(0, v));
  const px = fx - 0.5;
  const py = fy - 0.5;
  const x0 = clamp(Math.floor(px));
  const y0 = clamp(Math.floor(py));
  const x1 = clamp(x0 + 1);
  const y1 = clamp(y0 + 1);
  const wx = Math.min(1, Math.max(0, px - x0));
  const wy = Math.min(1, Math.max(0, py - y0));
  const at = (xx, yy) => {
    const i = (yy * TILE_SIZE + xx) * 4;
    return decodeTerrarium(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
  };
  const top = at(x0, y0) * (1 - wx) + at(x1, y0) * wx;
  const bottom = at(x0, y1) * (1 - wx) + at(x1, y1) * wx;
  return top * (1 - wy) + bottom * wy;
}
