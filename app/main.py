from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from app import geocode, maps
from app.routing import graph, loop
from app.schemas import PlanRequest, PlanResponse

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="api-app")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


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

    target_m = request.distance_km * 1000
    try:
        walk_graph, graph_warnings = graph.load_scored_graph(lat, lng, target_m)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"could not load map data for this area: {exc}"
        ) from exc
    warnings += graph_warnings

    try:
        route = loop.plan_route(walk_graph, lat, lng, target_m)
    except loop.NoRouteError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    warnings += route.warnings

    return PlanResponse(
        google_maps_url=maps.google_maps_url(route.coords),
        distance_m=round(route.length_m, 1),
        requested_distance_m=target_m,
        green_fraction=round(route.green_fraction, 3),
        route_type=route.route_type,
        start=(lat, lng),
        path=route.coords,
        warnings=warnings,
    )
