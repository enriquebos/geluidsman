from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    database_url: SecretStr = SecretStr("")
    discord_token: SecretStr = SecretStr("")
    discord_application_id: int = 1502044170406199416
    discord_guild_id: int = 1352422295402057759
    discord_client_secret: SecretStr = SecretStr("")
    auth_encryption_key: SecretStr = SecretStr("")
    app_base_url: str = "http://127.0.0.2:8687"
    app_admin_ids: list[str] = Field(default_factory=list)
    host: str = "0.0.0.0"
    port: int = 8687
    data_dir: Path = ROOT / "data"
    max_source_seconds: int = Field(3600, ge=1)
    max_import_bytes: int = Field(1_000_000_000, ge=1)
    max_storage_bytes: int = Field(10_000_000_000, ge=1)
    max_channel_videos: int = Field(2000, ge=1, le=10000)
    max_clip_seconds: float = Field(60, ge=0.1, le=300)
    max_playbacks: int = Field(8, ge=1, le=32)
    import_timeout_seconds: int = Field(1800, ge=10)
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    js_runtime: str = "deno"
    transcription_url: str = "http://transcription:8000"

    @field_validator("app_base_url")
    @classmethod
    def valid_origin(cls, value: str) -> str:
        value = value.rstrip("/")
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.path
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            message = "APP_BASE_URL must be an HTTP(S) origin without a path, credentials, query or fragment."
            raise ValueError(message)
        return value


def get_settings() -> Settings:
    settings = Settings()
    if not settings.data_dir.is_absolute():
        settings.data_dir = ROOT / settings.data_dir
    return settings
