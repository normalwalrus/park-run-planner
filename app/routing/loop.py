"""Find a running route of roughly a target length on a greenness-weighted graph.

Triangle heuristic for loops: for a fan of compass bearings, pick two via-points
about a third of the target distance away, connect start -> A -> B -> start with
weighted shortest paths (penalizing edges already used so the loop does not
retrace itself), and keep the greenest loop whose length lands near the target.
Falls back to an out-and-back along the greenest path when no loop fits.

The search is turn-aware: Dijkstra runs over (arrived-from, node) states and
every transition pays a penalty scaled by the turn angle, so straight, smooth
paths are preferred over zigzags with the same length. Bearings use edge
geometry when present (osmnx simplifies ways into curved edges), so smooth
curves cost nothing.
"""

import heapq
import math
from dataclasses import dataclass, field
from itertools import count

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

# Turn penalties, in weighted meters added on top of the edge cost.
TURN_FREE_DEG = 35  # gentle bends are free
TURN_SHARP_DEG = 80
TURN_REVERSE_DEG = 130
TURN_PENALTY_LIGHT = 8.0
TURN_PENALTY_SHARP = 25.0
TURN_PENALTY_REVERSE = 80.0


@dataclass
class RouteResult:
    coords: list[tuple[float, float]]  # (lat, lng) along the route
    length_m: float
    green_fraction: float
    route_type: str  # "loop" | "out_and_back" | "one_way"
    warnings: list[str] = field(default_factory=list)
    pairs: set[frozenset] = field(default_factory=set)  # edges used, for avoid on re-plan
    sharp_turns: int = 0


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


def _bearing_deg(y0: float, x0: float, y1: float, x1: float) -> float:
    scale = math.cos(math.radians((y0 + y1) / 2))
    return math.degrees(math.atan2((x1 - x0) * scale, y1 - y0))


def _edge_bearing(graph: nx.MultiDiGraph, u, v, at_end: bool) -> float:
    """Bearing of the (u, v) edge's first (exit at u) or last (entry at v) segment.

    Simplified osmnx edges carry curved geometry; using the segment nearest the
    junction means a gently curving path is not mistaken for a sharp corner.
    """
    geom = _best_edge(graph, u, v).get("geometry")
    if geom is not None and len(geom.coords) >= 2:
        (x0, y0), (x1, y1) = (geom.coords[-2], geom.coords[-1]) if at_end else geom.coords[:2]
    else:
        x0, y0 = graph.nodes[u]["x"], graph.nodes[u]["y"]
        x1, y1 = graph.nodes[v]["x"], graph.nodes[v]["y"]
    return _bearing_deg(y0, x0, y1, x1)


def _turn_angle_deg(b1: float, b2: float) -> float:
    d = abs(b1 - b2) % 360
    return 360 - d if d > 180 else d


def _turn_penalty(angle_deg: float) -> float:
    if angle_deg < TURN_FREE_DEG:
        return 0.0
    if angle_deg < TURN_SHARP_DEG:
        return TURN_PENALTY_LIGHT
    if angle_deg < TURN_REVERSE_DEG:
        return TURN_PENALTY_SHARP
    return TURN_PENALTY_REVERSE


def _edge_pairs(path: list) -> set[frozenset]:
    return {frozenset((u, v)) for u, v in zip(path, path[1:])}


def _prepared_adj(graph) -> dict:
    """Per-node adjacency with best-edge weight, bearings, and pair precomputed.

    Cached on the graph object: the hot Dijkstra loop must not touch edge dicts
    or shapely geometry per relaxation.
    """
    adj = graph.graph.get("_turn_aware_adj")
    if adj is None:
        adj = {}
        for u in graph.nodes:
            entries = []
            for v in graph[u]:
                data = _best_edge(graph, u, v)
                entries.append(
                    (
                        v,
                        data.get("w", data.get("length", 1.0)),
                        _edge_bearing(graph, u, v, at_end=False),  # exit bearing at u
                        _edge_bearing(graph, u, v, at_end=True),  # entry bearing at v
                        frozenset((u, v)),
                    )
                )
            adj[u] = entries
        graph.graph["_turn_aware_adj"] = adj
    return adj


def _dijkstra(graph, source, used=None, target=None, avoid=None):
    """Turn-aware Dijkstra over (arrived-from, node) states."""
    adj = _prepared_adj(graph)
    start_state = (None, source)
    dist = {start_state: 0.0}
    prev_state: dict = {}
    settled: set = set()
    tiebreak = count()
    # heap items carry the entry bearing of the arrival edge to avoid lookups
    heap = [(0.0, next(tiebreak), start_state, None)]
    target_state = None
    while heap:
        d, _, state, bearing_in = heapq.heappop(heap)
        if state in settled:
            continue
        settled.add(state)
        frm, u = state
        if u == target:
            target_state = state
            break
        for v, w, exit_bearing, entry_bearing, pair in adj[u]:
            if v == frm:
                continue  # no immediate U-turns
            if used and pair in used:
                w = w * REUSE_PENALTY
            if avoid and pair in avoid:
                w = w * AVOID_PENALTY
            if bearing_in is not None:
                w = w + _turn_penalty(_turn_angle_deg(bearing_in, exit_bearing))
            nd = d + w
            next_state = (u, v)
            if nd < dist.get(next_state, math.inf):
                dist[next_state] = nd
                prev_state[next_state] = state
                heapq.heappush(heap, (nd, next(tiebreak), next_state, entry_bearing))
    return dist, prev_state, settled, target_state


def _state_path(prev_state: dict, state) -> list:
    path = [state[1]]
    while state in prev_state:
        state = prev_state[state]
        path.append(state[1])
    return path[::-1]


def _shortest_path(graph, a, b, used=None, avoid=None) -> list | None:
    _, prev_state, _, target_state = _dijkstra(graph, a, used=used, target=b, avoid=avoid)
    return None if target_state is None else _state_path(prev_state, target_state)


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


def _count_sharp_turns(graph: nx.MultiDiGraph, path: list) -> int:
    turns = 0
    for t, u, v in zip(path, path[1:], path[2:]):
        angle = _turn_angle_deg(
            _edge_bearing(graph, t, u, at_end=True), _edge_bearing(graph, u, v, at_end=False)
        )
        if angle >= TURN_SHARP_DEG:
            turns += 1
    return turns


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
    leg1 = _shortest_path(graph, start, a, avoid=avoid)
    if leg1 is None:
        return None
    used = _edge_pairs(leg1)
    leg2 = _shortest_path(graph, a, b, used=used, avoid=avoid)
    if leg2 is None:
        return None
    used |= _edge_pairs(leg2)
    leg3 = _shortest_path(graph, b, start, used=used, avoid=avoid)
    if leg3 is None:
        return None
    path = leg1 + leg2[1:] + leg3[1:]
    length, green = _path_stats(graph, path)
    if length == 0:
        return None
    deviation = abs(length - target_m) / target_m
    green_fraction = green / length
    return (green_fraction - 2 * deviation, deviation, path, length, green_fraction)


def _to_result(graph, path, length, green_fraction, route_type, warnings) -> RouteResult:
    coords = [(graph.nodes[n]["y"], graph.nodes[n]["x"]) for n in path]
    return RouteResult(
        coords,
        length,
        green_fraction,
        route_type,
        warnings,
        _edge_pairs(path),
        _count_sharp_turns(graph, path),
    )


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
            warnings = []
            if tolerance == RELAXED_TOLERANCE:
                warnings.append(
                    f"closest loop found is {length / 1000:.1f} km "
                    f"({deviation:.0%} off the requested distance)"
                )
            return _to_result(graph, path, length, green_fraction, "loop", warnings)
    return None


def _greenest_path_tree(graph: nx.MultiDiGraph, start, avoid: set[frozenset] | None):
    """Greenest-path tree from start over turn-aware states.

    Returns (prev_state, length_to, green_to) with per-state true/green lengths,
    accumulated in increasing weighted distance so parents come first.
    """
    dist, prev_state, settled, _ = _dijkstra(graph, start, avoid=avoid)
    start_state = (None, start)
    length_to = {start_state: 0.0}
    green_to = {start_state: 0.0}
    for state in sorted(settled, key=dist.get):
        if state not in prev_state:
            continue  # start state
        parent = prev_state[state]
        data = _best_edge(graph, parent[1], state[1])
        edge_len = data.get("length", 1.0)
        length_to[state] = length_to[parent] + edge_len
        green_to[state] = green_to[parent] + (edge_len if data.get("green") else 0.0)
    return prev_state, length_to, green_to


def _best_tree_state(start, length_to: dict, green_to: dict, target_len: float):
    """State whose tree path best combines greenness with closeness to target_len."""
    best = None
    for state, length in length_to.items():
        if state[1] == start or length == 0:
            continue
        deviation = abs(length - target_len) / target_len
        green_fraction = green_to[state] / length
        score = green_fraction - 2 * deviation
        if best is None or score > best[0]:
            best = (score, state, length, deviation, green_fraction)
    if best is None:
        raise NoRouteError("no reachable route from the start point")
    return best


def _find_out_and_back(
    graph: nx.MultiDiGraph, start, target_m: float, avoid: set[frozenset] | None = None
) -> RouteResult:
    prev_state, length_to, green_to = _greenest_path_tree(graph, start, avoid)
    _, state, length, _, green_fraction = _best_tree_state(start, length_to, green_to, target_m / 2)
    out = _state_path(prev_state, state)
    path = out + out[-2::-1]
    return _to_result(
        graph,
        path,
        length * 2,
        green_fraction,
        "out_and_back",
        ["no loop matched the requested distance; returning an out-and-back route"],
    )


def _find_one_way(
    graph: nx.MultiDiGraph, start, target_m: float, avoid: set[frozenset] | None = None
) -> RouteResult:
    """One-way "straight path": the full target distance ending away from the start."""
    prev_state, length_to, green_to = _greenest_path_tree(graph, start, avoid)
    _, state, length, deviation, green_fraction = _best_tree_state(
        start, length_to, green_to, target_m
    )
    warnings = []
    if deviation > LENGTH_TOLERANCE:
        warnings.append(
            f"closest straight route is {length / 1000:.1f} km "
            f"({deviation:.0%} off the requested distance)"
        )
    return _to_result(
        graph, _state_path(prev_state, state), length, green_fraction, "one_way", warnings
    )


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
