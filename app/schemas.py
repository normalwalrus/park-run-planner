from pydantic import BaseModel, Field, model_validator

from app.geocode import in_singapore


class PlanRequest(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    address: str | None = None
    distance_km: float = Field(ge=1, le=30)

    @model_validator(mode="after")
    def check_location(self) -> "PlanRequest":
        has_coords = self.lat is not None and self.lng is not None
        if not has_coords and not self.address:
            raise ValueError("provide either lat/lng or an address")
        if has_coords and not in_singapore(self.lat, self.lng):
            raise ValueError("location is outside Singapore; this planner covers Singapore only")
        return self


class PlanResponse(BaseModel):
    google_maps_url: str
    distance_m: float
    requested_distance_m: float
    green_fraction: float
    route_type: str
    start: tuple[float, float]
    path: list[tuple[float, float]]
    warnings: list[str] = []
