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

# Road-crossing penalties by severity (weighted meters; green path costs 0.4/m,
# so 60 weighted-m ~ 150 m of green detour tolerated to avoid a minor road,
# and up to ~400 m to avoid crossing a primary road).
CROSS_PENALTY = (0.0, 60.0, 110.0, 160.0)  # index = road level

# Elevation preference ("none" = flattest, "low" = gentle rises ok, "high" =
# seek climbs). Penalties in weighted meters per meter climbed; "high" instead
# discounts climbing edges so the search is drawn toward them.
ELEV_PENALTY_PER_M = {"none": 10.0, "low": 1.5, "high": 0.0}
HILL_DISCOUNT_MAX = 0.5  # a steep edge costs as little as half its weight


def _elevation_score(elev: str, gain: float | None, length_m: float) -> float:
    """Candidate-level nudge: "none" prefers the flattest candidate, "high" the
    hilliest, judged by average grade (gain / length)."""
    if gain is None or length_m == 0:
        return 0.0
    grade = gain / length_m
    if elev == "none":
        return -grade * 20
    if elev == "high":
        return min(grade, 0.06) / 0.06 * 0.4
    return 0.0


CROSS_DEDUPE_M = 30.0  # dual carriageways count once in the stat
# `service` (driveways, car-park aisles) is deliberately excluded — cutting
# across a driveway is not a road crossing to a runner.
ROAD_LEVELS = {
    "residential": 1,
    "living_street": 1,
    "unclassified": 1,
    "tertiary": 2,
    "tertiary_link": 2,
    "secondary": 2,
    "secondary_link": 2,
    "primary": 3,
    "primary_link": 3,
    "trunk": 3,
    "trunk_link": 3,
}


def _road_level(data: dict) -> int:
    highway = data.get("highway")
    values = highway if isinstance(highway, list) else [highway]
    return max((ROAD_LEVELS.get(h, 0) for h in values), default=0)


@dataclass
class RouteResult:
    coords: list[tuple[float, float]]  # (lat, lng) along the route
    length_m: float
    green_fraction: float
    route_type: str  # "loop" | "out_and_back" | "one_way"
    warnings: list[str] = field(default_factory=list)
    pairs: set[frozenset] = field(default_factory=set)  # edges used, for avoid on re-plan
    roads_crossed: int = 0
    elevation_gain_m: float | None = None  # largest single climb; None without elevation data


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


def _prepared_adj(graph) -> tuple[dict, dict]:
    """(adjacency, node road levels) with weights, bearings, pair, and road level
    precomputed per edge.

    Cached on the graph object: the hot Dijkstra loop must not touch edge dicts
    or shapely geometry per relaxation.
    """
    cached = graph.graph.get("_turn_aware_adj")
    if cached is None:
        adj = {}
        node_road: dict = {}
        for u in graph.nodes:
            entries = []
            u_elev = graph.nodes[u].get("elevation", 0.0)
            for v in graph[u]:
                data = _best_edge(graph, u, v)
                road = _road_level(data)
                length = data.get("length", 1.0)
                gain = max(0.0, graph.nodes[v].get("elevation", 0.0) - u_elev)
                entries.append(
                    (
                        v,
                        data.get("w", length),
                        _edge_bearing(graph, u, v, at_end=False),  # exit bearing at u
                        _edge_bearing(graph, u, v, at_end=True),  # entry bearing at v
                        frozenset((u, v)),
                        road,
                        gain,
                        gain / length if length > 0 else 0.0,  # grade
                    )
                )
                if road:
                    node_road[u] = max(node_road.get(u, 0), road)
                    node_road[v] = max(node_road.get(v, 0), road)
            adj[u] = entries
        cached = (adj, node_road)
        graph.graph["_turn_aware_adj"] = cached
    return cached


def _dijkstra(graph, source, used=None, target=None, avoid=None, elev="low"):
    """Turn-aware Dijkstra over (arrived-from, node) states."""
    adj, node_road = _prepared_adj(graph)
    start_state = (None, source)
    dist = {start_state: 0.0}
    prev_state: dict = {}
    settled: set = set()
    tiebreak = count()
    # heap items carry the arrival edge's entry bearing and whether it is a road
    heap = [(0.0, next(tiebreak), start_state, None, False)]
    target_state = None
    while heap:
        d, _, state, bearing_in, arrived_by_road = heapq.heappop(heap)
        if state in settled:
            continue
        settled.add(state)
        frm, u = state
        if u == target:
            target_state = state
            break
        # Crossing a road at u: we pass through a road-carrying node while both
        # arriving and leaving on non-road paths (walking along a road is free).
        u_road = node_road.get(u, 0)
        for v, w, exit_bearing, entry_bearing, pair, road, gain, grade in adj[u]:
            if v == frm:
                continue  # no immediate U-turns
            if elev == "high":
                w = w * max(HILL_DISCOUNT_MAX, 1 - grade * 5)
            else:
                w = w + ELEV_PENALTY_PER_M[elev] * gain
            if used and pair in used:
                w = w * REUSE_PENALTY
            if avoid and pair in avoid:
                w = w * AVOID_PENALTY
            if bearing_in is not None:
                w = w + _turn_penalty(_turn_angle_deg(bearing_in, exit_bearing))
            if frm is not None and not arrived_by_road and not road and u_road:
                w = w + CROSS_PENALTY[u_road]
            nd = d + w
            next_state = (u, v)
            if nd < dist.get(next_state, math.inf):
                dist[next_state] = nd
                prev_state[next_state] = state
                heapq.heappush(heap, (nd, next(tiebreak), next_state, entry_bearing, road > 0))
    return dist, prev_state, settled, target_state


def _state_path(prev_state: dict, state) -> list:
    path = [state[1]]
    while state in prev_state:
        state = prev_state[state]
        path.append(state[1])
    return path[::-1]


def _shortest_path(graph, a, b, used=None, avoid=None, elev="low") -> list | None:
    _, prev_state, _, target_state = _dijkstra(
        graph, a, used=used, target=b, avoid=avoid, elev=elev
    )
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


def _count_road_crossings(graph: nx.MultiDiGraph, path: list) -> int:
    """Roads crossed along the path: interior nodes carrying a road where the
    route arrives and leaves on non-road paths. Crossings within CROSS_DEDUPE_M
    of the previous one count once (dual carriageways read as a single road)."""
    _, node_road = _prepared_adj(graph)
    crossings = 0
    walked = 0.0
    last_at = -math.inf
    for t, u, v in zip(path, path[1:], path[2:]):
        in_edge = _best_edge(graph, t, u)
        walked += in_edge.get("length", 1.0)
        out_edge = _best_edge(graph, u, v)
        if not _road_level(in_edge) and not _road_level(out_edge) and node_road.get(u, 0) > 0:
            if walked - last_at > CROSS_DEDUPE_M:
                crossings += 1
            last_at = walked
    return crossings


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


def _evaluate_loop(graph, start, a, b, target_m, avoid, elev) -> tuple | None:
    leg1 = _shortest_path(graph, start, a, avoid=avoid, elev=elev)
    if leg1 is None:
        return None
    used = _edge_pairs(leg1)
    leg2 = _shortest_path(graph, a, b, used=used, avoid=avoid, elev=elev)
    if leg2 is None:
        return None
    used |= _edge_pairs(leg2)
    leg3 = _shortest_path(graph, b, start, used=used, avoid=avoid, elev=elev)
    if leg3 is None:
        return None
    path = leg1 + leg2[1:] + leg3[1:]
    length, green = _path_stats(graph, path)
    if length == 0:
        return None
    deviation = abs(length - target_m) / target_m
    green_fraction = green / length
    gains = _elevation_gains(graph, path)
    score = (
        green_fraction
        - 2 * deviation
        + _elevation_score(elev, None if gains is None else gains[0], length)
    )
    return (score, deviation, path, length, green_fraction)


GAIN_DEADBAND_M = 2.0  # DEM noise between close nodes must not become fake climb


def _elevation_gains(graph, path) -> tuple[float, float] | None:
    """(total ascent, largest single climb) in meters along the path, or None
    when elevation data is missing. Total ascent drives candidate scoring; the
    largest climb is what results report. A drop of at least the deadband ends
    a climb; smaller wobbles are hysteresis-filtered DEM noise.
    """
    if not graph.graph.get("elevation"):
        return None
    total = climb = max_climb = 0.0
    anchor = graph.nodes[path[0]].get("elevation", 0.0)
    for node in path[1:]:
        elev = graph.nodes[node].get("elevation", 0.0)
        delta = elev - anchor
        if delta >= GAIN_DEADBAND_M:
            total += delta
            climb += delta
            max_climb = max(max_climb, climb)
            anchor = elev
        elif delta <= -GAIN_DEADBAND_M:
            climb = 0.0
            anchor = elev
    return total, max_climb


def _to_result(graph, path, length, green_fraction, route_type, warnings) -> RouteResult:
    coords = [(graph.nodes[n]["y"], graph.nodes[n]["x"]) for n in path]
    gains = _elevation_gains(graph, path)
    return RouteResult(
        coords,
        length,
        green_fraction,
        route_type,
        warnings,
        _edge_pairs(path),
        _count_road_crossings(graph, path),
        None if gains is None else gains[1],
    )


def _find_loop(graph, start, target_m, ids, lats, lngs, avoid, elev) -> RouteResult | None:
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
            candidate = _evaluate_loop(graph, start, a, b, target_m, avoid, elev)
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


def _greenest_path_tree(graph: nx.MultiDiGraph, start, avoid: set[frozenset] | None, elev="low"):
    """Greenest-path tree from start over turn-aware states.

    Returns (prev_state, length_to, green_to) with per-state true/green lengths,
    accumulated in increasing weighted distance so parents come first.
    """
    dist, prev_state, settled, _ = _dijkstra(graph, start, avoid=avoid, elev=elev)
    start_state = (None, start)
    length_to = {start_state: 0.0}
    green_to = {start_state: 0.0}
    gain_to = {start_state: 0.0}
    for state in sorted(settled, key=dist.get):
        if state not in prev_state:
            continue  # start state
        parent = prev_state[state]
        data = _best_edge(graph, parent[1], state[1])
        edge_len = data.get("length", 1.0)
        length_to[state] = length_to[parent] + edge_len
        green_to[state] = green_to[parent] + (edge_len if data.get("green") else 0.0)
        delta = graph.nodes[state[1]].get("elevation", 0.0) - graph.nodes[parent[1]].get(
            "elevation", 0.0
        )
        gain_to[state] = gain_to[parent] + max(0.0, delta)
    return prev_state, length_to, green_to, gain_to


def _best_tree_state(start, length_to: dict, green_to: dict, gain_to: dict, target_len, elev):
    """State whose tree path best combines greenness with closeness to target_len."""
    best = None
    for state, length in length_to.items():
        if state[1] == start or length == 0:
            continue
        deviation = abs(length - target_len) / target_len
        green_fraction = green_to[state] / length
        score = green_fraction - 2 * deviation + _elevation_score(elev, gain_to[state], length)
        if best is None or score > best[0]:
            best = (score, state, length, deviation, green_fraction)
    if best is None:
        raise NoRouteError("no reachable route from the start point")
    return best


def _find_out_and_back(
    graph: nx.MultiDiGraph,
    start,
    target_m: float,
    avoid: set[frozenset] | None = None,
    elev: str = "low",
) -> RouteResult:
    prev_state, length_to, green_to, gain_to = _greenest_path_tree(graph, start, avoid, elev)
    _, state, length, _, green_fraction = _best_tree_state(
        start, length_to, green_to, gain_to, target_m / 2, elev
    )
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
    graph: nx.MultiDiGraph,
    start,
    target_m: float,
    avoid: set[frozenset] | None = None,
    elev: str = "low",
) -> RouteResult:
    """One-way "straight path": the full target distance ending away from the start."""
    prev_state, length_to, green_to, gain_to = _greenest_path_tree(graph, start, avoid, elev)
    _, state, length, deviation, green_fraction = _best_tree_state(
        start, length_to, green_to, gain_to, target_m, elev
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
    elev: str = "low",
) -> RouteResult:
    """Best-effort route of ~target_m meters starting near (lat, lng).

    shape: "loop" (start = end; falls back to out-and-back) or "straight"
    (one-way, ends away from the start).
    avoid: edge pairs of previously returned routes (RouteResult.pairs) to steer
    away from, so a re-plan yields a genuinely different "alternate route".
    elev: "none" (flattest) | "low" (default, gentle rises ok) | "high" (seek climbs).
    """
    if graph.number_of_nodes() < 2:
        raise NoRouteError("no walkable paths found around the start point")
    ids, lats, lngs = _node_arrays(graph)
    start = _nearest_node(ids, lats, lngs, lat, lng)
    if shape == "straight":
        return _find_one_way(graph, start, target_m, avoid, elev)
    loop = _find_loop(graph, start, target_m, ids, lats, lngs, avoid, elev)
    if loop is not None:
        return loop
    return _find_out_and_back(graph, start, target_m, avoid, elev)
