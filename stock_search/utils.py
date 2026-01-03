from datetime import UTC, datetime, timedelta


def timestamp_to_str(timestamp: float) -> str:
    """Convert a unix timestamp to a string in the format YYYY-MM-DD HH:MM:SS."""
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d %H:%M:%S")


def iso_to_str(iso_date: str) -> str:
    """Convert an ISO date string to YYYY-MM-DD HH:MM:SS format."""
    return datetime.fromisoformat(iso_date.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S")


def n_days_ago(n: int) -> str:
    """Get the date n days ago in the format YYYY-MM-DD."""
    return (datetime.now(UTC) - timedelta(days=n)).strftime("%Y-%m-%d")
