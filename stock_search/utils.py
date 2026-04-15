"""Provide shared ticker and value normalization helpers."""

from datetime import UTC, datetime
import re
from urllib.parse import parse_qsl, urlparse, urlunparse

import yfinance as yf


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


def extract_domain(url: str) -> str:
    """Extract the normalized domain from a URL."""
    try:
        return urlparse(normalize_url(url)).netloc.removeprefix("www.")
    except Exception:
        return url


def _normalize_ticker(ticker: str) -> str:
    """Normalize common ticker variants for Yahoo Finance compatibility."""
    return ticker.replace(" ", "-").replace(".", "-")


def normalize_ticker_symbol(value: str) -> str:
    """Normalize ticker for internal storage keys (uppercase + trim)."""
    return str(value).upper().strip()


def parse_ticker(ticker_or_query: str) -> str:
    """Return the display name for a ticker, falling back to the ticker itself."""
    ticker_or_query = _normalize_ticker(ticker_or_query.strip().upper())
    if re.match(r"^[A-Z]{1,4}$", ticker_or_query):
        return yf.Ticker(ticker_or_query).info.get("displayName", ticker_or_query)
    return ticker_or_query
