# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Park Run Planner — a FastAPI service that plans running loops preferring park connectors (Singapore PCN), parks, and footpaths over roadside running, returned as a Google Maps walking-directions link. Managed with [uv](https://docs.astral.sh/uv/), Python 3.12 (pinned in `.python-version`); all dependencies and tool config live in `pyproject.toml`.

## Commands

```bash
uv sync                                        # install/refresh the environment (.venv)
uv run uvicorn app.main:app --reload           # run the dev server (http://127.0.0.1:8000)
uv run pytest                                  # unit tests (network-free; integration excluded)
uv run pytest -m integration                   # integration tests (real OSM/Overpass downloads)
uv run pytest tests/test_loop.py::test_finds_loop_of_target_length  # single test
uv run ruff check .                            # lint
uv run ruff format .                           # format
uv add <pkg> / uv add --dev <pkg>              # dependencies
```

Always run Python tooling through `uv run` — do not pip-install into the system interpreter.

## Architecture

Google's Directions API cannot be told to prefer parks, so routing happens in-process on OpenStreetMap data; Google Maps is only the output format. The pipeline for `POST /api/routes/plan`:

1. `app/geocode.py` — resolves a free-text address via Nominatim (skipped when lat/lng given).
2. `app/routing/graph.py` — downloads the OSM walking network around the start (`osmnx`), radius scaled to the requested distance, marks edges inside park polygons (`in_park`) via an STRtree spatial join, then scores it. Two cache layers: osmnx's HTTP disk cache (`OSM_CACHE_DIR`, default `~/.cache/api-app/osmnx`) and an in-process LRU of scored graphs.
3. `app/routing/scoring.py` — assigns each edge `w = length × factor`: 0.4 for green (footway/path/cycleway tags, "Park Connector"/PCN names, park interiors), 1.0 neutral, 2.5 for big roads. `green` flag drives the reported green fraction.
4. `app/routing/loop.py` — triangle heuristic: via-points on a fan of bearings, three weighted shortest paths (already-used edges penalized ×3 to avoid retracing). Green-weighted paths meander far past crow-flies distance, so the via-point leg is rescaled by the median overshoot ratio over up to 3 rounds. Falls back to an out-and-back along the greenest path when no loop lands within ±20% of target.
5. `app/maps.py` — samples ≤9 waypoints evenly along the route into a `google.com/maps/dir/?api=1` walking URL (Google re-routes between waypoints, so waypoints pin the path onto the connectors).

The endpoint in `app/main.py` is deliberately a sync `def` so FastAPI runs the blocking osmnx/networkx work in its threadpool. `static/index.html` (served at `/`) is a dependency-free vanilla-JS page (Leaflet via CDN) that also accepts query params, e.g. `/?lat=1.3521&lng=103.8198&distance=5`, to auto-plan.

## Testing conventions

Unit tests never touch the network: `test_loop.py` builds synthetic ring/line graphs with real lat/lng geometry (see its `ring_graph`/`line_graph` helpers), `test_api.py` monkeypatches `app.routing.graph.load_scored_graph` and `app.routing.loop.plan_route`. Anything hitting OSM/Nominatim gets `@pytest.mark.integration` (excluded by default via `addopts`). First integration/graph request for an area takes ~20 s (Overpass download); repeats are fast via the disk cache.
