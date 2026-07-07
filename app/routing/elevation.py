"""Node elevations from AWS Terrain Tiles (Terrarium encoding) — mirrors docs/js/elevation.js.

elevation_m = (R * 256 + G + B / 256) - 32768, sampled from z13 PNG tiles
(~19 m/px), which is plenty for run planning and needs only a handful of tile
fetches per area.
"""

import math

import httpx
import networkx as nx
from PIL import Image

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
TILE_ZOOM = 13
TILE_SIZE = 256

_tile_cache: dict[str, Image.Image | None] = {}


def tile_coords(lat: float, lng: float, zoom: int = TILE_ZOOM) -> tuple[float, float]:
    n = 2**zoom
    x = (lng + 180) / 360 * n
    lat_rad = math.radians(lat)
    y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return x, y


def decode_terrarium(r: int, g: int, b: int) -> float:
    return r * 256 + g + b / 256 - 32768


def _fetch_tile(tx: int, ty: int) -> Image.Image | None:
    key = f"{TILE_ZOOM}/{tx}/{ty}"
    if key in _tile_cache:
        return _tile_cache[key]
    tile = None
    try:
        response = httpx.get(f"{TILE_URL}/{key}.png", timeout=15)
        response.raise_for_status()
        import io

        tile = Image.open(io.BytesIO(response.content)).convert("RGB")
    except Exception:
        tile = None
    _tile_cache[key] = tile
    return tile


def annotate_elevation(graph: nx.MultiDiGraph) -> bool:
    """Set an `elevation` attribute on every node; False if no tiles loaded."""
    needed: set[tuple[int, int]] = set()
    for _, data in graph.nodes(data=True):
        x, y = tile_coords(data["y"], data["x"])
        needed.add((int(x), int(y)))
    tiles = {key: _fetch_tile(*key) for key in needed}
    if all(tile is None for tile in tiles.values()):
        return False

    for _, data in graph.nodes(data=True):
        x, y = tile_coords(data["y"], data["x"])
        tile = tiles.get((int(x), int(y)))
        if tile is None:
            continue
        data["elevation"] = _sample_bilinear(
            tile, (x - int(x)) * TILE_SIZE, (y - int(y)) * TILE_SIZE
        )
    graph.graph["elevation"] = True
    return True


def _sample_bilinear(tile: Image.Image, fx: float, fy: float) -> float:
    """Bilinear sampling smooths pixel-quantization jitter, which otherwise
    fakes climbs between closely spaced graph nodes (clamped at tile edges)."""

    def clamp(v: int) -> int:
        return min(TILE_SIZE - 1, max(0, v))

    px, py = fx - 0.5, fy - 0.5
    x0, y0 = clamp(math.floor(px)), clamp(math.floor(py))
    x1, y1 = clamp(x0 + 1), clamp(y0 + 1)
    wx = min(1.0, max(0.0, px - x0))
    wy = min(1.0, max(0.0, py - y0))

    def at(xx: int, yy: int) -> float:
        return decode_terrarium(*tile.getpixel((xx, yy)))

    top = at(x0, y0) * (1 - wx) + at(x1, y0) * wx
    bottom = at(x0, y1) * (1 - wx) + at(x1, y1) * wx
    return top * (1 - wy) + bottom * wy
