"""Yahoo Finance source adapter.

This module exposes provider-ready Yahoo snapshots for info, history, and analyst ratings. The adapter is intentionally source-local and does not apply cross-provider fallback. Downstream orchestration should handle precedence.
"""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import math
from typing import Any, cast

import pandas as pd
import yfinance as yf


def _safe_float(value: Any) -> float | None:
    """Safely parse finite float values from provider payloads."""
    with suppress(TypeError, ValueError):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    return None


def normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize ticker format for Yahoo endpoints."""
    return ticker.strip().upper().replace(" ", "-").replace(".", "-")


@dataclass(frozen=True)
class YahooInfoSnapshot:
    """Raw Yahoo `info` payload snapshot."""

    raw_info: dict[str, Any]


@dataclass(frozen=True)
class YahooHistorySnapshot:
    """Historical OHLCV snapshot from Yahoo history."""

    period: str
    interval: str | None
    prepost: bool
    history: pd.DataFrame


@dataclass(frozen=True)
class YahooRatingsSnapshot:
    """Analyst ratings snapshot derived from upgrades/downgrades."""

    median_upside_pct: float | None
    ratings: list[dict[str, Any]]


class YahooFinanceSource:
    """Provider-ready Yahoo Finance adapter."""

    def __init__(self, ticker: str | yf.Ticker):
        if isinstance(ticker, yf.Ticker):
            self.ticker = ticker
            symbol = str(getattr(ticker, "ticker", "") or "")
            self.ticker_symbol = normalize_yahoo_ticker(symbol) if symbol else ""
        else:
            self.ticker_symbol = normalize_yahoo_ticker(ticker)
            self.ticker = yf.Ticker(self.ticker_symbol)
        self._info_snapshot: YahooInfoSnapshot | None = None
        self._history_cache: dict[str, YahooHistorySnapshot] = {}
        self._ratings_cache: dict[int, YahooRatingsSnapshot | None] = {}

    def get_info_snapshot(self) -> YahooInfoSnapshot:
        """Fetch and cache a Yahoo `info` snapshot."""
        if self._info_snapshot is None:
            info: dict[str, Any] = {}
            with suppress(Exception):
                info = self.ticker.info or {}
            self._info_snapshot = YahooInfoSnapshot(raw_info=info)
        return self._info_snapshot

    def get_history_snapshot(
        self,
        *,
        period: str,
        interval: str | None = None,
        prepost: bool = False,
    ) -> YahooHistorySnapshot:
        """Fetch and cache a Yahoo history snapshot for the given request."""
        cache_key = f"{period}|{interval or ''}|prepost={prepost}"
        if cache_key in self._history_cache:
            return self._history_cache[cache_key]

        history = pd.DataFrame()
        with suppress(Exception):
            kwargs: dict[str, Any] = {"period": period, "prepost": prepost}
            if interval:
                kwargs["interval"] = interval
            result = self.ticker.history(**kwargs)
            if isinstance(result, pd.DataFrame):
                history = result

        snapshot = YahooHistorySnapshot(
            period=period,
            interval=interval,
            prepost=prepost,
            history=history,
        )
        self._history_cache[cache_key] = snapshot
        return snapshot

    def get_ratings_snapshot(self, days: int = 90) -> YahooRatingsSnapshot | None:
        """Fetch and cache analyst ratings snapshot over a lookback window."""
        if days in self._ratings_cache:
            return self._ratings_cache[days]

        info = self.get_info_snapshot().raw_info
        current_price = _safe_float(info.get("currentPrice")) or _safe_float(info.get("regularMarketPrice"))
        if current_price is None:
            self._ratings_cache[days] = None
            return None

        ratings_data: Any = None
        with suppress(Exception):
            ratings_data = self.ticker.upgrades_downgrades

        if ratings_data is None or isinstance(ratings_data, dict):
            self._ratings_cache[days] = None
            return None
        if isinstance(ratings_data, pd.DataFrame) and ratings_data.empty:
            self._ratings_cache[days] = None
            return None

        ratings_df = cast(pd.DataFrame, ratings_data).copy()
        try:
            ratings_df.index = pd.to_datetime(ratings_df.index, utc=True)
            cutoff = datetime.now(UTC) - timedelta(days=days)
            recent = ratings_df[ratings_df.index >= cutoff]
            if recent.empty:
                self._ratings_cache[days] = None
                return None

            upside_pct = ((recent["currentPriceTarget"] - current_price) / current_price * 100).round(2)
            snapshot = YahooRatingsSnapshot(
                median_upside_pct=float(upside_pct.median()),
                ratings=recent.to_dict("records"),
            )
            self._ratings_cache[days] = snapshot
            return snapshot
        except Exception:
            self._ratings_cache[days] = None
            return None
