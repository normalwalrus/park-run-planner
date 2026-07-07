"""Singapore place / address / postal-code lookup via OneMap."""

import os

import httpx

ONEMAP_URL = os.environ.get("ONEMAP_URL", "https://www.onemap.gov.sg")
USER_AGENT = "api-app-running-route-planner/0.1"

# Singapore bounding box: (south, west, north, east).
SG_BOUNDS = (1.13, 103.6, 1.47, 104.1)


def in_singapore(lat: float, lng: float) -> bool:
    south, west, north, east = SG_BOUNDS
    return south <= lat <= north and west <= lng <= east


class GeocodeError(Exception):
    pass


def geocode(query: str) -> tuple[float, float]:
    """Top OneMap match for a place name, address, or 6-digit postal code."""
    response = httpx.get(
        f"{ONEMAP_URL}/api/common/elastic/search",
        params={"searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    response.raise_for_status()
    for result in response.json().get("results", []):
        try:
            lat, lng = float(result["LATITUDE"]), float(result["LONGITUDE"])
        except (KeyError, ValueError):
            continue
        if in_singapore(lat, lng):
            return lat, lng
    raise GeocodeError(f"no results in Singapore for: {query!r}")
