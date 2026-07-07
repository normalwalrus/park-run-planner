import math

import networkx as nx
import pytest

from app.routing import loop, scoring

CENTER = (1.0, 103.0)
M_PER_DEG = 111_320.0


def _offset(lat: float, lng: float, north_m: float, east_m: float) -> tuple[float, float]:
    return (
        lat + north_m / M_PER_DEG,
        lng + east_m / (M_PER_DEG * math.cos(math.radians(lat))),
    )


def _add_node(graph: nx.MultiDiGraph, node, lat: float, lng: float) -> None:
    graph.add_node(node, y=lat, x=lng)


def _connect(graph: nx.MultiDiGraph, u, v, length: float, highway: str) -> None:
    graph.add_edge(u, v, length=length, highway=highway)
    graph.add_edge(v, u, length=length, highway=highway)


def ring_graph(radius_m: float = 400, n: int = 36) -> nx.MultiDiGraph:
    """A green ring around a center node, joined by one neutral spoke."""
    graph = nx.MultiDiGraph()
    _add_node(graph, "start", *CENTER)
    for i in range(n):
        bearing = math.radians(360 * i / n)
        lat, lng = _offset(
            *CENTER, north_m=radius_m * math.cos(bearing), east_m=radius_m * math.sin(bearing)
        )
        _add_node(graph, i, lat, lng)
    arc = 2 * math.pi * radius_m / n
    for i in range(n):
        _connect(graph, i, (i + 1) % n, arc, "footway")
    _connect(graph, "start", 0, radius_m, "residential")
    scoring.score_graph(graph)
    return graph


def line_graph(spacing_m: float = 100, n: int = 21) -> nx.MultiDiGraph:
    """A straight neutral path east of the center; no loops exist."""
    graph = nx.MultiDiGraph()
    for i in range(n):
        lat, lng = _offset(*CENTER, north_m=0, east_m=spacing_m * i)
        _add_node(graph, i, lat, lng)
    for i in range(n - 1):
        _connect(graph, i, i + 1, spacing_m, "residential")
    scoring.score_graph(graph)
    return graph


def test_finds_loop_of_target_length():
    graph = ring_graph()
    target = 3300.0  # ~ring circumference (2513) + spoke out and back (800)
    route = loop.plan_route(graph, *CENTER, target)
    assert route.route_type == "loop"
    assert abs(route.length_m - target) / target <= loop.RELAXED_TOLERANCE
    assert route.coords[0] == route.coords[-1]


def test_loop_prefers_green_edges():
    route = loop.plan_route(ring_graph(), *CENTER, 3300.0)
    # the ring (green) dominates; only the two spoke traversals are neutral
    assert route.green_fraction > 0.7


def test_search_prefers_longer_green_path():
    graph = nx.MultiDiGraph()
    _add_node(graph, "a", *CENTER)
    _add_node(graph, "b", *_offset(*CENTER, 0, 200))
    _add_node(graph, "via", *_offset(*CENTER, 100, 100))
    _connect(graph, "a", "b", 200, "primary")
    _connect(graph, "a", "via", 150, "footway")
    _connect(graph, "via", "b", 150, "footway")
    scoring.score_graph(graph)
    path = loop._shortest_path(graph, "a", "b")
    assert path == ["a", "via", "b"]  # 300 m green beats 200 m main road


def test_out_and_back_fallback_on_line():
    graph = line_graph()  # 2 km of straight path, target 3 km loop is impossible
    route = loop.plan_route(graph, *CENTER, 3000.0)
    assert route.route_type == "out_and_back"
    assert route.length_m == pytest.approx(3000.0)
    assert route.coords[0] == route.coords[-1]
    assert route.warnings
    assert route.roads_crossed == 0  # running along a street is not a crossing


def crossing_graph() -> nx.MultiDiGraph:
    """A footway cutting across a residential road at X, and a slightly longer
    footway detour via Y that avoids the crossing entirely."""
    graph = nx.MultiDiGraph()
    _add_node(graph, "A", *CENTER)
    _add_node(graph, "X", *_offset(*CENTER, 0, 100))
    _add_node(graph, "B", *_offset(*CENTER, 0, 200))
    _add_node(graph, "Y", *_offset(*CENTER, 30, 100))  # shallow detour, no sharp turns
    _add_node(graph, "R1", *_offset(*CENTER, 50, 100))
    _add_node(graph, "R2", *_offset(*CENTER, -50, 100))
    _connect(graph, "A", "X", 100, "footway")
    _connect(graph, "X", "B", 100, "footway")
    _connect(graph, "A", "Y", 110, "footway")
    _connect(graph, "Y", "B", 110, "footway")
    _connect(graph, "R1", "X", 50, "residential")  # the road runs through X
    _connect(graph, "X", "R2", 50, "residential")
    scoring.score_graph(graph)
    return graph


def test_crossing_penalty_prefers_detour_over_cutting_across_road():
    # direct: 200m footway (w=80) + minor crossing (60) = 140; detour: 220m (w=88)
    path = loop._shortest_path(crossing_graph(), "A", "B")
    assert path == ["A", "Y", "B"]


def test_roads_crossed_counted_and_deduped():
    graph = nx.MultiDiGraph()
    for node, east in [("A", 0), ("X1", 100), ("X2", 120), ("X3", 220), ("B", 320)]:
        _add_node(graph, node, *_offset(*CENTER, 0, east))
    _connect(graph, "A", "X1", 100, "footway")
    _connect(graph, "X1", "X2", 20, "footway")
    _connect(graph, "X2", "X3", 100, "footway")
    _connect(graph, "X3", "B", 100, "footway")
    # road stubs mark X1/X2 (a dual carriageway pair) and X3 (a separate road)
    for i, x in enumerate(["X1", "X2", "X3"]):
        _add_node(graph, f"s{i}", *_offset(*CENTER, 30, 100 + i * 10))
        _connect(graph, x, f"s{i}", 30, "residential")
    scoring.score_graph(graph)
    route = loop.plan_route(graph, *CENTER, 320.0, shape="straight")
    assert route.roads_crossed == 2  # X1+X2 merge into one, X3 is the second


def zigzag_graph() -> nx.MultiDiGraph:
    """Two ways A->B: a zigzag shorter on paper, and a slightly longer straight chain."""
    graph = nx.MultiDiGraph()
    _add_node(graph, "A", *CENTER)
    _add_node(graph, "B", *_offset(*CENTER, 0, 400))
    # straight chain, 4 edges, weighted length 110 each = 440
    chain = ["A", "s1", "s2", "s3", "B"]
    for i, node in enumerate(chain[1:-1], start=1):
        _add_node(graph, node, *_offset(*CENTER, 0, 100 * i))
    for u, v in zip(chain, chain[1:]):
        _connect(graph, u, v, 110, "residential")
    # zigzag E,N,E,S,...: 8 edges with 7 right-angle turns, length 50 each = 400
    corners = [(0, 100), (100, 100), (100, 200), (0, 200), (0, 300), (100, 300), (100, 400)]
    zchain = ["A"] + [f"z{i}" for i in range(len(corners))] + ["B"]
    for node, (north, east) in zip(zchain[1:-1], corners):
        _add_node(graph, node, *_offset(*CENTER, north, east))
    for u, v in zip(zchain, zchain[1:]):
        _connect(graph, u, v, 50, "residential")
    scoring.score_graph(graph)
    return graph


def test_turn_penalties_prefer_straight_over_shorter_zigzag():
    path = loop._shortest_path(zigzag_graph(), "A", "B")
    assert path == ["A", "s1", "s2", "s3", "B"]


def test_empty_graph_raises():
    graph = nx.MultiDiGraph()
    with pytest.raises(loop.NoRouteError):
        loop.plan_route(graph, *CENTER, 3000.0)


def grid_graph(spacing_m: float = 150, n: int = 5) -> nx.MultiDiGraph:
    """A street grid: many distinct loops of the same length exist."""
    graph = nx.MultiDiGraph()
    for i in range(n):
        for j in range(n):
            _add_node(graph, (i, j), *_offset(*CENTER, spacing_m * j, spacing_m * i))
    for i in range(n):
        for j in range(n):
            if i + 1 < n:
                _connect(graph, (i, j), (i + 1, j), spacing_m, "residential")
            if j + 1 < n:
                _connect(graph, (i, j), (i, j + 1), spacing_m, "residential")
    scoring.score_graph(graph)
    return graph


def test_straight_shape_gives_one_way_route():
    graph = line_graph()  # 2 km straight path, nodes every 100 m
    route = loop.plan_route(graph, *CENTER, 1500.0, shape="straight")
    assert route.route_type == "one_way"
    assert route.length_m == pytest.approx(1500.0)
    assert route.coords[0] != route.coords[-1]
    assert not route.warnings


def test_straight_shape_warns_when_network_too_small():
    route = loop.plan_route(line_graph(), *CENTER, 10000.0, shape="straight")
    assert route.route_type == "one_way"
    assert route.length_m <= 2000
    assert "closest straight route" in route.warnings[0]


def test_avoid_yields_a_different_alternate_route():
    graph = grid_graph()
    first = loop.plan_route(graph, *CENTER, 1800.0)
    assert first.pairs
    second = loop.plan_route(graph, *CENTER, 1800.0, avoid=first.pairs)
    assert first.coords != second.coords
    assert second.coords[0] == second.coords[-1]
