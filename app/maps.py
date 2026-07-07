"""Build a Google Maps walking-directions URL from a route's coordinates."""

import math
from urllib.parse import urlencode

MAX_WAYPOINTS = 9


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * (
        math.sin((lng2 - lng1) / 2) ** 2
    )
    return 6371000 * 2 * math.asin(math.sqrt(h))


def sample_waypoints(
    path: list[tuple[float, float]], count: int = MAX_WAYPOINTS
) -> list[tuple[float, float]]:
    """Pick `count` points evenly spaced by cumulative distance along the path.

    Excludes the endpoints (they become origin/destination).
    """
    if len(path) <= 2:
        return []
    cumulative = [0.0]
    for prev, cur in zip(path, path[1:]):
        cumulative.append(cumulative[-1] + _haversine_m(prev, cur))
    total = cumulative[-1]
    if total == 0:
        return []
    count = min(count, len(path) - 2)
    waypoints = []
    idx = 0
    for i in range(1, count + 1):
        target = total * i / (count + 1)
        while idx < len(cumulative) - 1 and cumulative[idx] < target:
            idx += 1
        waypoints.append(path[idx])
    # drop consecutive duplicates
    deduped: list[tuple[float, float]] = []
    for wp in waypoints:
        if not deduped or wp != deduped[-1]:
            deduped.append(wp)
    return deduped


def _fmt(point: tuple[float, float]) -> str:
    return f"{point[0]:.5f},{point[1]:.5f}"


def google_maps_url(path: list[tuple[float, float]]) -> str:
    """Walking directions through waypoints sampled along the route.

    Google re-routes between waypoints, so the waypoints pin the route onto
    the intended park connectors; origin and destination are the loop's start.
    """
    params = {
        "api": "1",
        "origin": _fmt(path[0]),
        "destination": _fmt(path[-1]),
        "travelmode": "walking",
    }
    waypoints = sample_waypoints(path)
    if waypoints:
        params["waypoints"] = "|".join(_fmt(wp) for wp in waypoints)
    return "https://www.google.com/maps/dir/?" + urlencode(params)
