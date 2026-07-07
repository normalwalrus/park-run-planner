"""Download and cache the OSM walking network around a point, scored for greenness."""

import os
from pathlib import Path

import networkx as nx
import osmnx as ox
from shapely import STRtree
from shapely.geometry import Point

from app.routing import scoring

ox.settings.use_cache = True
ox.settings.cache_folder = os.environ.get(
    "OSM_CACHE_DIR", str(Path.home() / ".cache" / "api-app" / "osmnx")
)

PARK_TAGS = {
    "leisure": ["park", "nature_reserve", "garden"],
    "landuse": ["recreation_ground", "grass"],
}
MIN_RADIUS_M = 1000
MAX_RADIUS_M = 6000

_graph_cache: dict[tuple, tuple[nx.MultiDiGraph, list[str]]] = {}
_GRAPH_CACHE_MAX = 8


def radius_for(distance_m: float) -> float:
    """A loop of length L rarely extends past ~L/2.5 from its start."""
    return min(max(distance_m / 2.2 + 400, MIN_RADIUS_M), MAX_RADIUS_M)


def _edge_midpoints(graph: nx.MultiDiGraph) -> list[Point]:
    points = []
    for u, v, data in graph.edges(data=True):
        geom = data.get("geometry")
        if geom is not None:
            points.append(geom.interpolate(0.5, normalized=True))
        else:
            points.append(
                Point(
                    (graph.nodes[u]["x"] + graph.nodes[v]["x"]) / 2,
                    (graph.nodes[u]["y"] + graph.nodes[v]["y"]) / 2,
                )
            )
    return points


def _mark_park_edges(graph: nx.MultiDiGraph, lat: float, lng: float, radius: float) -> None:
    """Set in_park=True on edges whose midpoint lies inside a park polygon."""
    features = ox.features_from_point((lat, lng), tags=PARK_TAGS, dist=radius)
    polygons = [geom for geom in features.geometry if geom.geom_type in ("Polygon", "MultiPolygon")]
    if not polygons:
        return
    tree = STRtree(polygons)
    midpoints = _edge_midpoints(graph)
    inside_idx, _ = tree.query(midpoints, predicate="intersects")
    edges = list(graph.edges(keys=True))
    for i in set(inside_idx):
        u, v, k = edges[i]
        graph.edges[u, v, k]["in_park"] = True


def load_scored_graph(
    lat: float, lng: float, distance_m: float
) -> tuple[nx.MultiDiGraph, list[str]]:
    """Walking graph around (lat, lng), edges annotated with w/green. Returns (graph, warnings)."""
    radius = radius_for(distance_m)
    key = (round(lat, 3), round(lng, 3), int(radius // 500))
    if key in _graph_cache:
        return _graph_cache[key]

    graph = ox.graph_from_point((lat, lng), dist=radius, network_type="walk", simplify=True)
    warnings: list[str] = []
    try:
        _mark_park_edges(graph, lat, lng, radius)
    except Exception:
        warnings.append("park boundary data unavailable; greenness is based on path tags only")
    scoring.score_graph(graph)

    if len(_graph_cache) >= _GRAPH_CACHE_MAX:
        _graph_cache.pop(next(iter(_graph_cache)))
    _graph_cache[key] = (graph, warnings)
    return graph, warnings
