# 🏃 Park Run Planner

Plan running routes that stick to **park connectors, parks, and footpaths** instead of roadside pavements. Give it where you are (or an address) and how far you want to run, and it returns a loop of roughly that distance plus a **Google Maps walking link** you can follow on your phone.

Built for Singapore: the planner is scoped to Singapore's Park Connector Network (PCN) and parks — the map is locked to the island and locations outside Singapore are rejected. Start-point search is powered by [OneMap](https://www.onemap.gov.sg/) (© Singapore Land Authority): as you type, a dropdown suggests places, addresses, and 6-digit postal codes, with popular running spots (East Coast Park, MacRitchie, Bishan-AMK Park, …) ranked first. Picking a suggestion sets the start point; **Plan my run** kicks off the planning, with a progress bar showing elapsed time against an estimate (longer on the first request for an area, when map data downloads). After a route is shown, **Alternate route** re-plans with the same start and distance while steering away from the segments already used, giving a genuinely different loop each press.

**How it's different from Google Maps:** Google's Directions API can't be told to prefer parks. This planner downloads the OpenStreetMap walking network around your start point, re-weights every path segment by "greenness" (park connectors and park paths are cheap, main roads are expensive), searches for a loop of your target distance on that weighted graph, and only then hands the result to Google Maps as a set of waypoints that pin the route onto the green paths.

## ✨ Use it now (hosted, free)

**https://normalwalrus.github.io/park-run-planner/**

The hosted version is a static page — the whole routing pipeline (OSM download via Overpass, greenness scoring, loop search) runs in your browser. No server, no API keys. Deep-link a plan with query params:

```
https://normalwalrus.github.io/park-run-planner/?lat=1.3521&lng=103.8198&distance=5
https://normalwalrus.github.io/park-run-planner/?address=Bishan%20Park%2C%20Singapore&distance=8
```

The static app lives in [`docs/`](docs/) (vanilla ES modules, no build step) and mirrors the Python routing in `app/routing/` — the sections below describe the algorithm both share.

## Self-host the API (Python)

Requires [uv](https://docs.astral.sh/uv/getting-started/installation/) (Python 3.12 is resolved automatically).

```bash
git clone https://github.com/normalwalrus/park-run-planner.git
cd park-run-planner
uv sync
uv run uvicorn app.main:app --reload
```

Open **http://127.0.0.1:8000/** — allow location access (or type an address), pick a distance, hit **Plan my run**, then tap **Open in Google Maps** on your phone.

> The first request for a new area downloads OSM data and can take ~20–30 s. Repeat requests for the same area are sub-second (disk + memory cache).

You can also deep-link a plan: `http://127.0.0.1:8000/?lat=1.3521&lng=103.8198&distance=5&shape=straight` (`shape` is `loop` by default). A **Route shape** toggle in the form picks between a loop (start = end) and a straight one-way route that ends away from the start.

## API

Interactive docs at `http://127.0.0.1:8000/docs`.

### `POST /api/routes/plan`

```bash
curl -X POST http://127.0.0.1:8000/api/routes/plan \
  -H 'content-type: application/json' \
  -d '{"lat": 1.3521, "lng": 103.8198, "distance_km": 5}'
```

Request body — either coordinates or an address, plus a distance:

| field | type | notes |
|---|---|---|
| `lat`, `lng` | float | start coordinates (e.g. from browser geolocation); must be within Singapore |
| `address` | string | place name, street address, or 6-digit postal code, resolved via OneMap (used when no coords) |
| `distance_km` | float | 1–30 |
| `route_shape` | string | `"loop"` (default; start = end) or `"straight"` (one-way, ends away from the start) |
| `elevation` | string | `"none"` (flattest), `"low"` (default; gentle rises ok), or `"high"` (seek climbs) |

Response:

```json
{
  "google_maps_url": "https://www.google.com/maps/dir/?api=1&origin=...&travelmode=walking&waypoints=...",
  "distance_m": 5012.2,
  "requested_distance_m": 5000.0,
  "green_fraction": 0.826,
  "route_type": "loop",
  "start": [1.3521, 103.8198],
  "path": [[1.35532, 103.82326], "..."],
  "warnings": []
}
```

- `green_fraction` — share of the route on park connectors, parks, or footpaths (0–1).
- `route_type` — `"loop"` normally; `"out_and_back"` when no loop fits the distance (with a warning); `"one_way"` for straight routes.
- `elevation_gain_m` — largest single climb in meters (`null` if elevation data was unavailable).
- `sights` — notable sights the route passes within 60 m (`{name, lat, lng}`, in encounter order): named parks plus named OSM tourism/historic features. With the request option `prioritize_sights: true` (default `false`; "Prioritise sights" in the app), routes gently prefer passing them when it costs little extra distance.
- Request option `stay_in_park` (default `false`) — strongly prefer staying in parks and along water (rivers, canals, reservoirs, the coast count as green): streets cost 4× their usual weight, becoming a last resort. When the route still needs streets to connect the green stretches, a warning says how much of it does.
- `path` — full route geometry (lat, lng), ready to draw on a map.
- Errors: `404` address not found in Singapore, `422` invalid input / location outside Singapore / no walkable paths, `502` OSM data unavailable.

### `GET /health`

Liveness check, returns `{"status": "ok"}`.

## How routing works

1. **Graph** — `osmnx` downloads the OSM walking network around the start (radius scales with distance, capped at 6 km) and marks edges inside `leisure=park`-style polygons via a spatial join.
2. **Scoring** — each edge gets a weight `length × factor`: **0.4** for green (footway/path/cycleway/pedestrian/track tags, names matching *Park Connector*/*PCN*, or inside a park), **1.0** neutral (residential streets), **2.5** for primary/secondary/tertiary/trunk roads.
3. **Loop search** — triangle heuristic: pick two via-points on a fan of compass bearings, connect start → A → B → start with weighted shortest paths, penalizing already-used edges ×3 so the loop doesn't retrace itself. Because green-weighted paths meander, the via-point spacing is rescaled by the measured overshoot ratio over a few rounds until a loop lands within ±10 % of target (±20 % accepted with a warning). The search is **turn- and crossing-aware**: Dijkstra runs over (arrived-from, node) states; each transition pays a penalty scaled by the turn angle (gentle bends free, sharp corners costly, reversals heavily penalized, immediate U-turns forbidden) and a penalty for cutting across a road (scaled by road size — walking along a road is free, and driveways don't count), so routes prefer straight, smooth paths with as few road crossings as possible. The response reports `roads_crossed` (every crossing counts — a dual carriageway is two). **Elevation** comes from AWS Terrain Tiles (Terrarium DEM, bilinearly sampled): the `elevation` preference biases both the edge weights (climb penalties for "none"/"low", climb discounts for "high") and the candidate scoring by average grade, and routes report `elevation_gain_m` (2 m hysteresis so DEM noise doesn't count as climb).
4. **Output** — up to 9 waypoints sampled evenly along the loop go into a `google.com/maps/dir` walking URL; Google routes between waypoints, so the waypoints pin the route onto the green paths.

## Configuration

No API keys needed. Optional environment variables:

| variable | default | purpose |
|---|---|---|
| `OSM_CACHE_DIR` | `~/.cache/api-app/osmnx` | disk cache for OSM downloads |
| `ONEMAP_URL` | `https://www.onemap.gov.sg` | alternate OneMap endpoint (Python API only) |

## Development

```bash
uv run pytest                 # Python unit tests (fast, no network)
uv run pytest -m integration  # end-to-end against real OSM data
uv run ruff check .           # lint
uv run ruff format .          # format
node --test tests/js/         # tests for the static app's routing port
python3 -m http.server -d docs 8200   # serve the static app locally
```

The routing algorithm exists twice — `app/routing/` (Python, for the API) and `docs/js/` (JavaScript, for the static page). Changes to scoring or loop search should be made in both; each has a matching unit-test suite on synthetic graphs.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (via Overpass API); search powered by [OneMap](https://www.onemap.gov.sg/) © Singapore Land Authority; elevation from [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen Terrarium).
