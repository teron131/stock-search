from datetime import UTC, datetime, timedelta


def datetime_to_str(date_time: datetime) -> str:
    """Convert a datetime object to a string in the format YYYY-MM-DD HH:MM:SS."""
    return datetime.fromtimestamp(date_time, UTC).strftime("%Y-%m-%d %H:%M:%S")


def n_days_ago(n: int) -> str:
    """Get the date n days ago in the format YYYY-MM-DD."""
    return (datetime.now(UTC) - timedelta(days=n)).strftime("%Y-%m-%d")
