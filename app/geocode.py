"""Free-text address to coordinates via Nominatim."""

import os

import httpx

NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
# Nominatim's usage policy requires an identifying User-Agent.
USER_AGENT = "api-app-running-route-planner/0.1"


class GeocodeError(Exception):
    pass


def geocode(address: str) -> tuple[float, float]:
    response = httpx.get(
        f"{NOMINATIM_URL}/search",
        params={"q": address, "format": "json", "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    response.raise_for_status()
    results = response.json()
    if not results:
        raise GeocodeError(f"no results for address: {address!r}")
    return float(results[0]["lat"]), float(results[0]["lon"])
