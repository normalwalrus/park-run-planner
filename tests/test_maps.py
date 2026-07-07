from urllib.parse import parse_qs, urlparse

from app import maps


def _ring_path(n: int = 50) -> list[tuple[float, float]]:
    import math

    angles = [2 * math.pi * i / n for i in range(n)]
    path = [(1.35 + 0.004 * math.cos(a), 103.8 + 0.004 * math.sin(a)) for a in angles]
    return path + [path[0]]


def test_url_structure():
    url = maps.google_maps_url(_ring_path())
    parsed = urlparse(url)
    assert parsed.scheme == "https" and parsed.netloc == "www.google.com"
    params = parse_qs(parsed.query)
    assert params["api"] == ["1"]
    assert params["travelmode"] == ["walking"]
    assert params["origin"] == params["destination"]


def test_at_most_nine_waypoints():
    url = maps.google_maps_url(_ring_path(200))
    params = parse_qs(urlparse(url).query)
    waypoints = params["waypoints"][0].split("|")
    assert 1 <= len(waypoints) <= maps.MAX_WAYPOINTS


def test_waypoints_spread_along_path():
    path = _ring_path()
    waypoints = maps.sample_waypoints(path)
    indices = [path.index(wp) for wp in waypoints]
    assert indices == sorted(indices)
    assert len(set(indices)) == len(indices)


def test_short_path_has_no_waypoints():
    url = maps.google_maps_url([(1.35, 103.8), (1.36, 103.81)])
    assert "waypoints" not in parse_qs(urlparse(url).query)
