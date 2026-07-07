import pytest

from app import geocode


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _fake_get(payload):
    def get(url, params=None, headers=None, timeout=None):
        return FakeResponse(payload)

    return get


def test_postal_code_resolves(monkeypatch):
    payload = {
        "results": [
            {
                "SEARCHVAL": "406 ANG MO KIO AVENUE 10 SINGAPORE 560406",
                "LATITUDE": "1.36200453938712",
                "LONGITUDE": "103.853879910407",
            }
        ]
    }
    monkeypatch.setattr(geocode.httpx, "get", _fake_get(payload))
    lat, lng = geocode.geocode("560406")
    assert lat == pytest.approx(1.362, abs=1e-3)
    assert lng == pytest.approx(103.8539, abs=1e-3)


def test_results_outside_singapore_skipped(monkeypatch):
    payload = {
        "results": [
            {"SEARCHVAL": "SOMEWHERE ELSE", "LATITUDE": "51.5", "LONGITUDE": "-0.12"},
            {"SEARCHVAL": "BISHAN PARK", "LATITUDE": "1.3614", "LONGITUDE": "103.8455"},
        ]
    }
    monkeypatch.setattr(geocode.httpx, "get", _fake_get(payload))
    lat, lng = geocode.geocode("park")
    assert (lat, lng) == (1.3614, 103.8455)


def test_no_results_raises(monkeypatch):
    monkeypatch.setattr(geocode.httpx, "get", _fake_get({"results": []}))
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("zzzz")


def test_malformed_results_skipped(monkeypatch):
    payload = {"results": [{"SEARCHVAL": "BROKEN", "LATITUDE": "n/a"}]}
    monkeypatch.setattr(geocode.httpx, "get", _fake_get(payload))
    with pytest.raises(geocode.GeocodeError):
        geocode.geocode("broken")
