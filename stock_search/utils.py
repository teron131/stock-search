from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlparse, urlunparse

_DATE_FMT = "%Y-%m-%d"
_ISO_Z_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def format_date(value: datetime) -> str:
    """Format a datetime as YYYY-MM-DD (UTC)."""
    return value.astimezone(UTC).strftime(_DATE_FMT)


def format_iso_z(value: datetime) -> str:
    """Format a datetime as ISO 8601 with Z suffix (UTC)."""
    return value.astimezone(UTC).strftime(_ISO_Z_FMT)


def normalize_url(url: str) -> str:
    """Normalize URLs for deduping across sources."""
    parsed = urlparse(url)
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    query = [
        (key, value)
        for key, value in parse_qsl(
            parsed.query,
            keep_blank_values=True,
        )
        if not key.startswith("utm_")
    ]
    normalized = parsed._replace(
        netloc=netloc,
        path=path,
        query="&".join(f"{k}={v}" for k, v in query),
    )
    return urlunparse(normalized)
