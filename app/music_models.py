from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator


class MusicTrack(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["youtube", "spotify"]
    source_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    album: str | None = Field(default=None, max_length=300)
    duration: float = Field(gt=0, le=86400, allow_inf_nan=False)
    thumbnail: str | None = Field(default=None, max_length=2048)
    url: str = Field(default="", max_length=2048)
    youtube_id: str | None = Field(default=None, pattern=r"^[\w-]{11}$")
    youtube_title: str | None = Field(default=None, max_length=300)
    original_title: str | None = Field(default=None, max_length=300)
    upload_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    upload_name: str | None = Field(default=None, max_length=255)
    match_locked: StrictBool = False

    @model_validator(mode="after")
    def canonical_source(self) -> MusicTrack:
        pattern = r"[A-Za-z0-9_-]{11}" if self.provider == "youtube" else r"[A-Za-z0-9]{22}"
        if not re.fullmatch(pattern, self.source_id):
            message = "Choose a valid YouTube video or Spotify track."
            raise ValueError(message)
        if self.provider == "youtube":
            self.youtube_id = self.source_id
            self.url = "https://www.youtube.com/watch?v=" + self.source_id
        else:
            self.url = "https://open.spotify.com/track/" + self.source_id
        if self.thumbnail:
            parsed = urlsplit(self.thumbnail)
            if parsed.scheme != "https" or parsed.hostname not in {"i.ytimg.com", "i.scdn.co", "mosaic.scdn.co"}:
                self.thumbnail = None
            else:
                self.thumbnail = urlunsplit(("https", parsed.hostname, parsed.path, "", ""))
        return self


class MusicSavedOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    playlist_id: str = Field(min_length=1, max_length=64)
    index: int = Field(ge=0, lt=1000)
    expected_updated_at: float = Field(gt=0, allow_inf_nan=False)


class MusicTracksInput(BaseModel):
    saved_origin: MusicSavedOrigin | None = None
    tracks: list[MusicTrack] = Field(min_length=1, max_length=1000)


class MusicTrackInput(BaseModel):
    saved_origin: MusicSavedOrigin | None = None
    track: MusicTrack


class MusicLikeInput(MusicTrackInput):
    liked: StrictBool


class MusicMembershipInput(MusicTrackInput):
    saved: StrictBool


class MusicIdentity(BaseModel):
    provider: Literal["youtube", "spotify"]
    source_id: str = Field(min_length=1, max_length=64)


class MusicLibraryStatusInput(BaseModel):
    tracks: list[MusicIdentity] = Field(min_length=1, max_length=1000)


class MusicLibraryQuery(BaseModel):
    provider: Literal["youtube", "spotify"]
    source_id: str = Field(min_length=1, max_length=64)
    q: str = Field(default="", max_length=100)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=50)


class MusicModeInput(BaseModel):
    mode: Literal["soundboard", "music"]


class MusicPlayerInput(BaseModel):
    action: Literal["play", "pause", "next", "previous", "seek", "shuffle", "repeat", "stop"]
    value: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)


class MusicOrderInput(BaseModel):
    ids: list[str] = Field(max_length=1600)


class MusicImportInput(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    destination: str = Field(default="queue", min_length=1, max_length=64)


class PlaylistInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    collaborative: StrictBool = False

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            message = "Enter a playlist name."
            raise ValueError(message)
        return value.strip()


class PlaylistUpdate(PlaylistInput):
    expected_updated_at: float = Field(gt=0, allow_inf_nan=False)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    collaborative: StrictBool | None = None
    tracks: list[MusicTrack] | None = Field(default=None, max_length=1000)


class PlaylistTrackUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=300)
    source_url: str | None = Field(default=None, min_length=1, max_length=1000)
    expected_updated_at: float = Field(gt=0, allow_inf_nan=False)

    @field_validator("name", "source_url")
    @classmethod
    def valid_text(cls, value: str | None) -> str | None:
        if value is not None:
            value = value.strip()
            if not value:
                message = "Enter a song name or a YouTube video URL."
                raise ValueError(message)
        return value

    @model_validator(mode="after")
    def has_changes(self) -> PlaylistTrackUpdate:
        if self.name is None and self.source_url is None:
            message = "Change the song name or source."
            raise ValueError(message)
        return self
