from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlparse, urlunparse


def parse_date(value: str | int | float | datetime) -> datetime:
    """Parse a date value into an aware datetime in UTC."""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC)
    dt = datetime.fromisoformat(value) if isinstance(value, str) else value
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def format_date(dt: datetime) -> str:
    """Format a datetime as YYYY-MM-DD in local timezone."""
    return dt.astimezone().strftime("%Y-%m-%d")


def format_iso_z(dt: datetime) -> str:
    """Format a datetime as ISO 8601 with Z suffix (UTC)."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def get_days_ago(dt: datetime) -> int:
    """Calculate days elapsed since a date in local timezone."""
    return (datetime.now().astimezone().date() - dt.astimezone().date()).days


def normalize_url(url: str) -> str:
    """Normalize URLs by lowering netloc, stripping trailing slashes, and removing UTM params."""
    p = urlparse(url)
    query = "&".join(f"{k}={v}" for k, v in parse_qsl(p.query) if not k.startswith("utm_"))
    return urlunparse(p._replace(netloc=p.netloc.lower(), path=p.path.rstrip("/"), query=query))
