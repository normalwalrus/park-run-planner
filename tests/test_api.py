import pytest
from fastapi.testclient import TestClient

from app import geocode
from app.main import app
from app.routing import graph as graph_module
from app.routing import loop as loop_module
from app.routing.loop import RouteResult

client = TestClient(app)

CANNED_ROUTE = RouteResult(
    coords=[(1.3521, 103.8198), (1.3600, 103.8300), (1.3521, 103.8198)],
    length_m=5050.0,
    green_fraction=0.82,
    route_type="loop",
    warnings=[],
)


@pytest.fixture
def fake_routing(monkeypatch):
    monkeypatch.setattr(graph_module, "load_scored_graph", lambda lat, lng, d: ("graph", []))
    monkeypatch.setattr(loop_module, "plan_route", lambda g, lat, lng, d: CANNED_ROUTE)


def test_plan_with_coordinates(fake_routing):
    response = client.post(
        "/api/routes/plan", json={"lat": 1.3521, "lng": 103.8198, "distance_km": 5}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["google_maps_url"].startswith("https://www.google.com/maps/dir/")
    assert body["distance_m"] == 5050.0
    assert body["requested_distance_m"] == 5000.0
    assert body["green_fraction"] == 0.82
    assert body["route_type"] == "loop"
    assert body["path"][0] == body["path"][-1]


def test_plan_with_address(fake_routing, monkeypatch):
    monkeypatch.setattr(geocode, "geocode", lambda address: (1.3521, 103.8198))
    response = client.post(
        "/api/routes/plan", json={"address": "Bishan Park, Singapore", "distance_km": 5}
    )
    assert response.status_code == 200
    assert response.json()["start"] == [1.3521, 103.8198]


def test_unknown_address_is_404(fake_routing, monkeypatch):
    def fail(address):
        raise geocode.GeocodeError("no results")

    monkeypatch.setattr(geocode, "geocode", fail)
    response = client.post("/api/routes/plan", json={"address": "zzzz", "distance_km": 5})
    assert response.status_code == 404


def test_missing_location_rejected():
    response = client.post("/api/routes/plan", json={"distance_km": 5})
    assert response.status_code == 422


def test_distance_out_of_range_rejected():
    response = client.post("/api/routes/plan", json={"lat": 1.35, "lng": 103.8, "distance_km": 50})
    assert response.status_code == 422


def test_index_serves_page():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
