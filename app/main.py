from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from app import geocode, maps
from app.routing import graph, loop
from app.schemas import PlanRequest, PlanResponse

# The server serves the same web app as GitHub Pages (docs/) so the two UIs
# can never drift apart; the JSON API below is the server-side engine.
DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"

app = FastAPI(title="api-app")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Sync endpoint on purpose: osmnx/networkx work is blocking, so FastAPI
# runs it in the threadpool instead of stalling the event loop.
@app.post("/api/routes/plan")
def plan(request: PlanRequest) -> PlanResponse:
    warnings: list[str] = []
    if request.lat is not None and request.lng is not None:
        lat, lng = request.lat, request.lng
    else:
        try:
            lat, lng = geocode.geocode(request.address)
        except geocode.GeocodeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not geocode.in_singapore(lat, lng):
            raise HTTPException(
                status_code=422,
                detail="location is outside Singapore; this planner covers Singapore only",
            )

    target_m = request.distance_km * 1000
    # A one-way route ranges up to the full distance from the start, a loop ~half.
    graph_distance_m = target_m * 2 if request.route_shape == "straight" else target_m
    try:
        walk_graph, graph_warnings = graph.load_scored_graph(lat, lng, graph_distance_m)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"could not load map data for this area: {exc}"
        ) from exc
    warnings += graph_warnings

    try:
        route = loop.plan_route(
            walk_graph,
            lat,
            lng,
            target_m,
            shape=request.route_shape,
            elev=request.elevation,
            stay=request.stay_in_park,
            sights=request.prioritize_sights,
        )
    except loop.NoRouteError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    warnings += route.warnings

    return PlanResponse(
        google_maps_url=maps.google_maps_url(route.coords),
        distance_m=round(route.length_m, 1),
        requested_distance_m=target_m,
        green_fraction=round(route.green_fraction, 3),
        route_type=route.route_type,
        roads_crossed=route.roads_crossed,
        elevation_gain_m=None
        if route.elevation_gain_m is None
        else round(route.elevation_gain_m, 1),
        sights=route.sights,
        start=(lat, lng),
        path=route.coords,
        warnings=warnings,
    )


# Mounted last so the API routes above take precedence.
app.mount("/", StaticFiles(directory=DOCS_DIR, html=True), name="app")
