"""Free-text address to coordinates via Nominatim, restricted to Singapore."""

import os

import httpx

NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
# Nominatim's usage policy requires an identifying User-Agent.
USER_AGENT = "api-app-running-route-planner/0.1"

# Singapore bounding box: (south, west, north, east).
SG_BOUNDS = (1.13, 103.6, 1.47, 104.1)


def in_singapore(lat: float, lng: float) -> bool:
    south, west, north, east = SG_BOUNDS
    return south <= lat <= north and west <= lng <= east


class GeocodeError(Exception):
    pass


def geocode(address: str) -> tuple[float, float]:
    south, west, north, east = SG_BOUNDS
    response = httpx.get(
        f"{NOMINATIM_URL}/search",
        params={
            "q": address,
            "format": "json",
            "limit": 1,
            "countrycodes": "sg",
            "viewbox": f"{west},{south},{east},{north}",
            "bounded": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    response.raise_for_status()
    results = response.json()
    if not results:
        raise GeocodeError(f"no results in Singapore for address: {address!r}")
    return float(results[0]["lat"]), float(results[0]["lon"])
