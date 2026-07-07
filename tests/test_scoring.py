import networkx as nx

from app.routing import scoring


def test_green_highway_tags():
    for highway in ["footway", "path", "cycleway", "pedestrian", "track"]:
        assert scoring.edge_factor({"highway": highway}) == scoring.GREEN_FACTOR


def test_park_connector_name_is_green():
    assert scoring.edge_factor({"highway": "residential", "name": "Kallang Park Connector"}) == (
        scoring.GREEN_FACTOR
    )
    assert scoring.edge_factor({"highway": "residential", "name": "PCN"}) == scoring.GREEN_FACTOR


def test_in_park_flag_is_green():
    assert scoring.edge_factor({"highway": "residential", "in_park": True}) == scoring.GREEN_FACTOR


def test_big_roads_penalized():
    for highway in ["primary", "secondary_link", "trunk"]:
        assert scoring.edge_factor({"highway": highway}) == scoring.ROAD_FACTOR


def test_neutral_and_missing_tags():
    assert scoring.edge_factor({"highway": "residential"}) == scoring.NEUTRAL_FACTOR
    assert scoring.edge_factor({}) == scoring.NEUTRAL_FACTOR


def test_highway_list_takes_best_factor():
    assert scoring.edge_factor({"highway": ["primary", "footway"]}) == scoring.GREEN_FACTOR
    assert scoring.edge_factor({"highway": ["primary", "residential"]}) == scoring.NEUTRAL_FACTOR


def test_score_graph_annotates_edges():
    graph = nx.MultiDiGraph()
    graph.add_edge(1, 2, length=100.0, highway="footway")
    graph.add_edge(2, 3, length=100.0, highway="primary")
    scoring.score_graph(graph)
    green_edge = graph.edges[1, 2, 0]
    road_edge = graph.edges[2, 3, 0]
    assert green_edge["green"] and green_edge["w"] == 100.0 * scoring.GREEN_FACTOR
    assert not road_edge["green"] and road_edge["w"] == 100.0 * scoring.ROAD_FACTOR
