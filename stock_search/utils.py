from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlparse, urlunparse

_DATE_FMT = "%Y-%m-%d"
_ISO_Z_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def get_local_tz() -> datetime.tzinfo:
    """Return the runtime's local timezone."""
    return datetime.now().astimezone().tzinfo


def parse_date(value: str | int | float | datetime, tz: datetime.tzinfo | None = None) -> datetime:
    """Parse a date value (ISO string, timestamp, or datetime) into an aware datetime."""
    if isinstance(value, (int, float)):
        dt = datetime.fromtimestamp(value, UTC)
    elif isinstance(value, str):
        dt = datetime.fromisoformat(value)
    else:
        dt = value

    return dt.replace(tzinfo=dt.tzinfo or tz or get_local_tz())


def format_date(dt: datetime, tz: datetime.tzinfo | None = None) -> str:
    """Format a datetime as YYYY-MM-DD in a target timezone (default Local)."""
    return dt.astimezone(tz or get_local_tz()).strftime(_DATE_FMT)


def format_iso_z(dt: datetime) -> str:
    """Format a datetime as ISO 8601 with Z suffix (UTC)."""
    return dt.astimezone(UTC).strftime(_ISO_Z_FMT)


def get_days_ago(dt: datetime, tz: datetime.tzinfo | None = None) -> int:
    """Calculate days elapsed since a date in the target timezone (default Local)."""
    tz = tz or get_local_tz()
    return (datetime.now(tz).date() - dt.astimezone(tz).date()).days


def normalize_url(url: str) -> str:
    """Normalize URLs by lowering netloc, stripping trailing slashes, and removing UTM params."""
    p = urlparse(url)
    query = "&".join(f"{k}={v}" for k, v in parse_qsl(p.query) if not k.startswith("utm_"))
    return urlunparse(p._replace(netloc=p.netloc.lower(), path=p.path.rstrip("/"), query=query))
