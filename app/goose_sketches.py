from __future__ import annotations

import json
import math
import uuid
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictStr, model_validator

from app.auth import authorize, authorize_admin

if TYPE_CHECKING:
    from fastapi import FastAPI

    from app.db import Database


MAX_POINTS = 512
MAX_DURATION = 60000
MAX_SKETCHES = 16

Coordinate = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class Stroke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    color: Literal["#ef3340", "#79c94c", "#5ba8f5", "#bfa2ff", "#26212e", "#fff9ef"]
    points: list[tuple[Coordinate, Coordinate]] = Field(min_length=2, max_length=512)

    @model_validator(mode="after")
    def coordinates(self) -> Stroke:
        if any(
            not math.isfinite(value) or not 0 <= value <= limit
            for point in self.points
            for value, limit in zip(point, (150, 130), strict=True)
        ):
            message = "Drawing coordinates must be finite and inside the canvas."
            raise ValueError(message)
        return self


class Sketch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: StrictStr = Field(min_length=1, max_length=60)
    strokes: list[Stroke] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def complexity(self) -> Sketch:
        if sum(len(stroke.points) for stroke in self.strokes) > MAX_POINTS:
            message = "Use at most 512 simplified points across all strokes. Simplify the drawing before saving."
            raise ValueError(message)
        if self.duration() > MAX_DURATION:
            message = "This drawing takes more than 60 seconds. Shorten strokes or use fewer strokes."
            raise ValueError(message)
        return self

    def duration(self) -> int:
        ink = sum(
            math.dist(first, second)
            for stroke in self.strokes
            for first, second in zip(stroke.points, stroke.points[1:], strict=False)
        )
        travel = sum(
            math.dist(first.points[-1], second.points[0])
            for first, second in zip(self.strokes, self.strokes[1:], strict=False)
        )
        return max(1000, math.ceil((ink / 90 + travel / 140) * 1000))


def change_library(db: Database, body: Sketch | None, identity: str | None = None) -> dict:
    with db.lock, db.conn:
        library = db.setting("goose_sketches", [])
        found = next((item for item in library if item["id"] == identity), None)
        if identity and not found:
            raise HTTPException(404, "Drawing not found.")
        if body is None:
            library.remove(found)
            result = {"deleted": True}
        else:
            if identity is None and len(library) >= MAX_SKETCHES:
                raise HTTPException(409, "The library holds at most 16 drawings. Delete one before adding another.")
            result = {
                "id": identity or uuid.uuid4().hex,
                **body.model_dump(mode="json"),
                "duration_ms": body.duration(),
            }
            if found:
                library[library.index(found)] = result
            else:
                library.append(result)
        db.conn.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", ("goose_sketches", json.dumps(library)))
        return result


def resolve_sketch(db: Database, identity: str | None) -> dict | None:
    if not identity:
        return None
    library = db.setting("goose_sketches", [])
    drawing = next((item for item in library if item["id"] == identity), None)
    if not drawing:
        raise HTTPException(404, "Drawing not found.")
    Sketch.model_validate({"name": drawing["name"], "strokes": drawing["strokes"]})
    return drawing


def register_sketch_routes(app: FastAPI) -> None:
    admin = {"dependencies": [Depends(authorize_admin)]}

    @app.get("/api/goose/sketches", dependencies=[Depends(authorize)])
    async def sketches() -> list:
        return await app.state.db.run(app.state.db.setting, "goose_sketches", [])

    @app.post("/api/admin/goose/sketches", **admin)
    async def create(body: Sketch) -> dict:
        result = await app.state.db.run(change_library, app.state.db, body)
        app.state.events.publish("fun.goose.library")
        return result

    @app.put("/api/admin/goose/sketches/{identity}", **admin)
    async def update(identity: str, body: Sketch) -> dict:
        result = await app.state.db.run(change_library, app.state.db, body, identity)
        app.state.events.publish("fun.goose.library")
        return result

    @app.delete("/api/admin/goose/sketches/{identity}", **admin)
    async def delete(identity: str) -> dict:
        result = await app.state.db.run(change_library, app.state.db, None, identity)
        app.state.events.publish("fun.goose.library")
        return result
