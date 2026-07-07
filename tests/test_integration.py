"""Hits real OSM/Overpass servers. Run with: uv run pytest -m integration"""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


@pytest.mark.integration
def test_plan_route_bishan_park():
    response = client.post(
        "/api/routes/plan",
        json={"lat": 1.3521, "lng": 103.8198, "distance_km": 5},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["google_maps_url"].startswith("https://www.google.com/maps/dir/")
    assert abs(body["distance_m"] - 5000) / 5000 <= 0.25
    assert 0 <= body["green_fraction"] <= 1
    assert len(body["path"]) > 10
