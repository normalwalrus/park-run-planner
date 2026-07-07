"""Find a running loop of roughly a target length on a greenness-weighted graph.

Triangle heuristic: for a fan of compass bearings, pick two via-points about a
third of the target distance away, connect start -> A -> B -> start with
weighted shortest paths (penalizing edges already used so the loop does not
retrace itself), and keep the greenest loop whose length lands near the target.
Falls back to an out-and-back along the greenest path when no loop fits.
"""

import math
from dataclasses import dataclass, field

import networkx as nx
import numpy as np

BEARING_STEP_DEG = 30
LENGTH_TOLERANCE = 0.10
RELAXED_TOLERANCE = 0.20
REUSE_PENALTY = 3.0
AVOID_PENALTY = 2.5  # edges of already-shown routes, for "alternate route" requests
MAX_ROUNDS = 3
MIN_LEG_M = 250.0
METERS_PER_DEG_LAT = 111_320.0


@dataclass
class RouteResult:
    coords: list[tuple[float, float]]  # (lat, lng) along the route
    length_m: float
    green_fraction: float
    route_type: str  # "loop" | "out_and_back"
    warnings: list[str] = field(default_factory=list)
    pairs: set[frozenset] = field(default_factory=set)  # edges used, for avoid on re-plan


class NoRouteError(Exception):
    pass


def _node_arrays(graph: nx.MultiDiGraph) -> tuple[list, np.ndarray, np.ndarray]:
    ids = list(graph.nodes)
    lats = np.array([graph.nodes[n]["y"] for n in ids])
    lngs = np.array([graph.nodes[n]["x"] for n in ids])
    return ids, lats, lngs


def _nearest_node(ids: list, lats: np.ndarray, lngs: np.ndarray, lat: float, lng: float):
    scale = math.cos(math.radians(lat))
    d2 = (lats - lat) ** 2 + ((lngs - lng) * scale) ** 2
    return ids[int(np.argmin(d2))]


def _project(lat: float, lng: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    rad = math.radians(bearing_deg)
    dlat = dist_m * math.cos(rad) / METERS_PER_DEG_LAT
    dlng = dist_m * math.sin(rad) / (METERS_PER_DEG_LAT * math.cos(math.radians(lat)))
    return lat + dlat, lng + dlng


def _best_edge(graph: nx.MultiDiGraph, u, v) -> dict:
    return min(graph[u][v].values(), key=lambda d: d.get("w", d.get("length", 1.0)))


def _path_stats(graph: nx.MultiDiGraph, path: list) -> tuple[float, float]:
    """(total length, length on green edges) for a node path."""
    length = green = 0.0
    for u, v in zip(path, path[1:]):
        data = _best_edge(graph, u, v)
        edge_len = data.get("length", 1.0)
        length += edge_len
        if data.get("green"):
            green += edge_len
    return length, green


def _weight_fn(used: set[frozenset], avoid: set[frozenset] | None = None):
    def weight(u, v, edges: dict) -> float:
        w = min(d.get("w", d.get("length", 1.0)) for d in edges.values())
        pair = frozenset((u, v))
        if pair in used:
            w *= REUSE_PENALTY
        if avoid and pair in avoid:
            w *= AVOID_PENALTY
        return w

    return weight


def _edge_pairs(path: list) -> set[frozenset]:
    return {frozenset((u, v)) for u, v in zip(path, path[1:])}


def _via_pairs(graph, start, leg_m, ids, lats, lngs, tried: set[tuple]):
    """Candidate (A, B) via-node pairs: a fan of bearings at crow-flies distance leg_m."""
    start_lat, start_lng = graph.nodes[start]["y"], graph.nodes[start]["x"]
    for bearing in range(0, 360, BEARING_STEP_DEG):
        a = _nearest_node(ids, lats, lngs, *_project(start_lat, start_lng, bearing, leg_m))
        b = _nearest_node(ids, lats, lngs, *_project(start_lat, start_lng, bearing + 120, leg_m))
        if len({start, a, b}) < 3 or (a, b) in tried:
            continue
        tried.add((a, b))
        yield a, b


def _evaluate_loop(graph, start, a, b, target_m, avoid) -> tuple | None:
    try:
        leg1 = nx.shortest_path(graph, start, a, weight=_weight_fn(set(), avoid))
        used = _edge_pairs(leg1)
        leg2 = nx.shortest_path(graph, a, b, weight=_weight_fn(used, avoid))
        used |= _edge_pairs(leg2)
        leg3 = nx.shortest_path(graph, b, start, weight=_weight_fn(used, avoid))
    except nx.NetworkXNoPath:
        return None
    path = leg1 + leg2[1:] + leg3[1:]
    length, green = _path_stats(graph, path)
    if length == 0:
        return None
    deviation = abs(length - target_m) / target_m
    green_fraction = green / length
    return (green_fraction - 2 * deviation, deviation, path, length, green_fraction)


def _find_loop(graph, start, target_m, ids, lats, lngs, avoid) -> RouteResult | None:
    # Green-weighted shortest paths meander well past crow-flies distance, so
    # the right via-point spacing is unknown up front: start at target/3 and,
    # while the resulting loops miss the target, rescale the legs by the
    # median overshoot ratio and try again.
    candidates: list[tuple] = []
    tried: set[tuple] = set()
    leg = target_m / 3
    for _ in range(MAX_ROUNDS):
        round_lengths = []
        for a, b in _via_pairs(graph, start, leg, ids, lats, lngs, tried):
            candidate = _evaluate_loop(graph, start, a, b, target_m, avoid)
            if candidate is None:
                continue
            candidates.append(candidate)
            round_lengths.append(candidate[3])
        if any(c[1] <= LENGTH_TOLERANCE for c in candidates) or not round_lengths:
            break
        median = sorted(round_lengths)[len(round_lengths) // 2]
        leg = max(MIN_LEG_M, leg * target_m / median)

    for tolerance in (LENGTH_TOLERANCE, RELAXED_TOLERANCE):
        fitting = [c for c in candidates if c[1] <= tolerance]
        if fitting:
            score, deviation, path, length, green_fraction = max(fitting, key=lambda c: c[0])
            coords = [(graph.nodes[n]["y"], graph.nodes[n]["x"]) for n in path]
            warnings = []
            if tolerance == RELAXED_TOLERANCE:
                warnings.append(
                    f"closest loop found is {length / 1000:.1f} km "
                    f"({deviation:.0%} off the requested distance)"
                )
            return RouteResult(coords, length, green_fraction, "loop", warnings, _edge_pairs(path))
    return None


def _greenest_path_tree(graph: nx.MultiDiGraph, start, avoid: set[frozenset] | None):
    """Greenest-path tree from start: (paths, true length, green length) per node.

    Lengths are accumulated in increasing weighted distance so parents come first.
    """
    dist_w, paths = nx.single_source_dijkstra(graph, start, weight=_weight_fn(set(), avoid))
    length_to = {start: 0.0}
    green_to = {start: 0.0}
    for node in sorted(dist_w, key=dist_w.get):
        if node == start:
            continue
        pred = paths[node][-2]
        data = _best_edge(graph, pred, node)
        edge_len = data.get("length", 1.0)
        length_to[node] = length_to[pred] + edge_len
        green_to[node] = green_to[pred] + (edge_len if data.get("green") else 0.0)
    return paths, length_to, green_to


def _best_tree_node(start, length_to: dict, green_to: dict, target_len: float):
    """Node whose tree path best combines greenness with closeness to target_len."""
    best = None
    for node, length in length_to.items():
        if node == start or length == 0:
            continue
        deviation = abs(length - target_len) / target_len
        green_fraction = green_to[node] / length
        score = green_fraction - 2 * deviation
        if best is None or score > best[0]:
            best = (score, node, length, deviation, green_fraction)
    if best is None:
        raise NoRouteError("no reachable route from the start point")
    return best


def _find_out_and_back(
    graph: nx.MultiDiGraph, start, target_m: float, avoid: set[frozenset] | None = None
) -> RouteResult:
    paths, length_to, green_to = _greenest_path_tree(graph, start, avoid)
    _, node, length, _, green_fraction = _best_tree_node(start, length_to, green_to, target_m / 2)
    out = paths[node]
    path = out + out[-2::-1]
    coords = [(graph.nodes[n]["y"], graph.nodes[n]["x"]) for n in path]
    return RouteResult(
        coords,
        length * 2,
        green_fraction,
        "out_and_back",
        ["no loop matched the requested distance; returning an out-and-back route"],
        _edge_pairs(path),
    )


def _find_one_way(
    graph: nx.MultiDiGraph, start, target_m: float, avoid: set[frozenset] | None = None
) -> RouteResult:
    """One-way "straight path": the full target distance ending away from the start."""
    paths, length_to, green_to = _greenest_path_tree(graph, start, avoid)
    _, node, length, deviation, green_fraction = _best_tree_node(
        start, length_to, green_to, target_m
    )
    path = paths[node]
    coords = [(graph.nodes[n]["y"], graph.nodes[n]["x"]) for n in path]
    warnings = []
    if deviation > LENGTH_TOLERANCE:
        warnings.append(
            f"closest straight route is {length / 1000:.1f} km "
            f"({deviation:.0%} off the requested distance)"
        )
    return RouteResult(coords, length, green_fraction, "one_way", warnings, _edge_pairs(path))


def plan_route(
    graph: nx.MultiDiGraph,
    lat: float,
    lng: float,
    target_m: float,
    avoid: set[frozenset] | None = None,
    shape: str = "loop",
) -> RouteResult:
    """Best-effort route of ~target_m meters starting near (lat, lng).

    shape: "loop" (start = end; falls back to out-and-back) or "straight"
    (one-way, ends away from the start).
    avoid: edge pairs of previously returned routes (RouteResult.pairs) to steer
    away from, so a re-plan yields a genuinely different "alternate route".
    """
    if graph.number_of_nodes() < 2:
        raise NoRouteError("no walkable paths found around the start point")
    ids, lats, lngs = _node_arrays(graph)
    start = _nearest_node(ids, lats, lngs, lat, lng)
    if shape == "straight":
        return _find_one_way(graph, start, target_m, avoid)
    loop = _find_loop(graph, start, target_m, ids, lats, lngs, avoid)
    if loop is not None:
        return loop
    return _find_out_and_back(graph, start, target_m, avoid)
