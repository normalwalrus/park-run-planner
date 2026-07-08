"""Assign a park-preferring cost to every edge of an OSM walking graph.

Each edge gets:
  w      -- length * factor; the weight used for shortest-path search
  green  -- True if the edge is a park connector, park path, or footpath
  factor -- the multiplier itself (kept for debugging)
"""

import re

import networkx as nx

GREEN_FACTOR = 0.4
NEUTRAL_FACTOR = 1.0
ROAD_FACTOR = 2.5

GREEN_HIGHWAYS = {"footway", "path", "pedestrian", "track", "cycleway", "bridleway"}
ROAD_HIGHWAYS = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "trunk",
    "trunk_link",
}

_PCN_NAME = re.compile(r"park connector|pcn", re.IGNORECASE)


def _as_list(value: object) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def edge_factor(data: dict) -> float:
    """Greenness multiplier for one edge's OSM attributes."""
    if data.get("in_park") or data.get("near_water"):
        return GREEN_FACTOR
    highways = _as_list(data.get("highway"))
    names = _as_list(data.get("name"))
    if any(_PCN_NAME.search(str(n)) for n in names):
        return GREEN_FACTOR
    if any(h in GREEN_HIGHWAYS for h in highways):
        return GREEN_FACTOR
    if highways and all(h in ROAD_HIGHWAYS for h in highways):
        return ROAD_FACTOR
    return NEUTRAL_FACTOR


def score_graph(graph: nx.MultiDiGraph) -> None:
    """Annotate every edge with w/green/factor in place."""
    for _, _, data in graph.edges(data=True):
        factor = edge_factor(data)
        data["factor"] = factor
        data["green"] = factor == GREEN_FACTOR
        data["w"] = data.get("length", 1.0) * factor
