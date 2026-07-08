from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.geocode import in_singapore


class PlanRequest(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    address: str | None = None
    distance_km: float = Field(ge=1, le=30)
    route_shape: Literal["loop", "straight"] = "loop"
    elevation: Literal["none", "low", "high"] = "low"

    @model_validator(mode="after")
    def check_location(self) -> "PlanRequest":
        has_coords = self.lat is not None and self.lng is not None
        if not has_coords and not self.address:
            raise ValueError("provide either lat/lng or an address")
        if has_coords and not in_singapore(self.lat, self.lng):
            raise ValueError("location is outside Singapore; this planner covers Singapore only")
        return self


class Sight(BaseModel):
    name: str
    lat: float
    lng: float


class PlanResponse(BaseModel):
    google_maps_url: str
    distance_m: float
    requested_distance_m: float
    green_fraction: float
    route_type: str
    roads_crossed: int
    elevation_gain_m: float | None  # largest single climb along the route
    sights: list[Sight] = []  # notable sights the route passes
    start: tuple[float, float]
    path: list[tuple[float, float]]
    warnings: list[str] = []
