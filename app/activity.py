from __future__ import annotations

import math
import time
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import Depends, HTTPException, Query

from app.permissions import require_permission

if TYPE_CHECKING:
    from fastapi import FastAPI

    from app.config import Settings

MAX_BUCKETS = 100
MAX_RANGE_SECONDS = 91 * 86400


def register_activity_routes(app: FastAPI, settings: Settings) -> None:
    @app.get("/api/audit/activity", dependencies=[Depends(require_permission("view_audit"))])
    def activity(
        after: Annotated[float, Query(ge=0, allow_inf_nan=False)],
        until: Annotated[float, Query(ge=0, allow_inf_nan=False)],
        bucket_seconds: Annotated[int, Query(ge=3600, le=86400)] = 3600,
        sort: Literal["played", "created"] = "played",
    ) -> dict:
        duration = until - after
        count = math.ceil(duration / bucket_seconds)
        if bucket_seconds not in (3600, 86400) or duration <= 0 or duration > MAX_RANGE_SECONDS or count > MAX_BUCKETS:
            raise HTTPException(422, "Choose a valid period of up to 90 days with at most 100 chart intervals.")
        db = app.state.db
        guild_id = str(settings.discord_guild_id)
        retention = db.setting("app_settings", {}).get("audit_retention_days", 90)
        lower_bound = max(after, time.time() - retention * 86400)
        leaderboard = db.rows(
            "SELECT a.actor_id AS user_id,COALESCE(u.display_name,MAX(a.actor_name)) AS name,u.avatar,"
            "SUM(CASE WHEN a.action='sound.create' THEN 1 ELSE 0 END) AS created,"
            "SUM(CASE WHEN a.action='sound.play' THEN 1 ELSE 0 END) AS played "
            "FROM audit a LEFT JOIN users u ON u.id=a.actor_id "
            "WHERE a.timestamp>=? AND a.timestamp<? AND a.outcome='success' "
            "AND a.action IN ('sound.create','sound.play') AND a.actor_id IS NOT NULL "
            "AND (a.guild_id IS NULL OR a.guild_id=?) "
            "GROUP BY a.actor_id,u.display_name,u.avatar ORDER BY "
            "SUM(CASE WHEN a.action=? THEN 1 ELSE 0 END) DESC,name ASC LIMIT 50",
            (lower_bound, until, guild_id, "sound.play" if sort == "played" else "sound.create"),
        )
        rows = db.rows(
            "SELECT CAST(FLOOR((timestamp-?)/?) AS INTEGER) AS bucket,COUNT(*) AS played "
            "FROM audit WHERE timestamp>=? AND timestamp<? AND action='sound.play' AND outcome='success' "
            "AND (guild_id IS NULL OR guild_id=?) GROUP BY bucket ORDER BY bucket",
            (after, bucket_seconds, lower_bound, until, guild_id),
        )
        counts = {row["bucket"]: row["played"] for row in rows}
        return {
            "leaderboard": leaderboard,
            "series": [
                {"timestamp": after + index * bucket_seconds, "played": counts.get(index, 0)} for index in range(count)
            ],
            "total_played": sum(counts.values()),
            "after": after,
            "until": until,
        }
