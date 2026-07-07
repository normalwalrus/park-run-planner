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


def test_weight_prefers_longer_green_path():
    graph = nx.MultiDiGraph()
    _add_node(graph, "a", *CENTER)
    _add_node(graph, "b", *_offset(*CENTER, 0, 200))
    _add_node(graph, "via", *_offset(*CENTER, 100, 100))
    _connect(graph, "a", "b", 200, "primary")
    _connect(graph, "a", "via", 150, "footway")
    _connect(graph, "via", "b", 150, "footway")
    scoring.score_graph(graph)
    path = nx.shortest_path(graph, "a", "b", weight=loop._weight_fn(set()))
    assert path == ["a", "via", "b"]  # 300 m green beats 200 m main road


def test_out_and_back_fallback_on_line():
    graph = line_graph()  # 2 km of straight path, target 3 km loop is impossible
    route = loop.plan_route(graph, *CENTER, 3000.0)
    assert route.route_type == "out_and_back"
    assert route.length_m == pytest.approx(3000.0)
    assert route.coords[0] == route.coords[-1]
    assert route.warnings


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
