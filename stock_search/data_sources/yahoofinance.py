"""Yahoo Finance source adapter.

This module exposes provider-ready Yahoo snapshots for info, history, and analyst ratings. The adapter is intentionally source-local and does not apply cross-provider fallback. Downstream orchestration should handle precedence.
"""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cache
import math
from typing import Any, cast

import pandas as pd
import yfinance as yf

ETF_QUOTE_TYPE = "ETF"
DEFAULT_FX_LOOKBACK_PERIOD = "5d"
DEFAULT_FX_INTERVAL = "1d"
_SESSION_PRICE_KEYS: dict[str, str] = {
    "PRE": "preMarketPrice",
    "POST": "postMarketPrice",
    "POSTPOST": "postMarketPrice",
    "CLOSED": "postMarketPrice",
    "REGULAR": "regularMarketPrice",
}
_PRICE_FALLBACK_ORDER = ("regularMarketPrice", "postMarketPrice", "preMarketPrice")
_PRICE_TIME_KEYS: tuple[tuple[str, str], ...] = (
    ("preMarketPrice", "preMarketTime"),
    ("regularMarketPrice", "regularMarketTime"),
    ("postMarketPrice", "postMarketTime"),
)


def _safe_float(value: Any) -> float | None:
    """Safely parse finite float values from provider payloads."""
    with suppress(TypeError, ValueError):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    return None


def normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize ticker format for Yahoo endpoints."""
    return ticker.strip().upper().replace(" ", "-").replace(".", "-")


def _fiscal_weight_fy0(next_fiscal_year_end: float | None) -> float | None:
    """Weight of FY0 in a 12-month lookahead window."""
    if next_fiscal_year_end is None:
        return None
    days = (datetime.fromtimestamp(next_fiscal_year_end, tz=UTC) - datetime.now(tz=UTC)).total_seconds() / 86_400
    return min(1.0, max(0.0, days / 365.0))


def _close_series(hist: pd.DataFrame) -> pd.Series | None:
    """Return non-empty close series from a history frame."""
    if hist.empty or "Close" not in hist:
        return None
    series = hist["Close"].dropna()
    return series if not series.empty else None


def _latest_close_price(hist: pd.DataFrame) -> float | None:
    """Get latest non-null close from history frame."""
    series = _close_series(hist)
    return float(series.iloc[-1]) if series is not None else None


@cache
def _fx_rate(from_currency: str, to_currency: str) -> float | None:
    """Best-effort FX rate from `from_currency` to `to_currency`."""
    source, target = from_currency.strip().upper(), to_currency.strip().upper()
    if not source or not target:
        return None
    if source == target:
        return 1.0

    for pair, invert in ((f"{source}{target}=X", False), (f"{target}{source}=X", True)):
        with suppress(Exception):
            hist = yf.Ticker(pair).history(
                period=DEFAULT_FX_LOOKBACK_PERIOD,
                interval=DEFAULT_FX_INTERVAL,
            )
            if (price := _latest_close_price(hist)) is not None and price != 0:
                return 1.0 / price if invert else price
    return None


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

    @property
    def info(self) -> dict[str, Any]:
        """Convenience accessor for cached Yahoo info payload."""
        return self.get_info_snapshot().raw_info

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

    def get_quote_type(self) -> str:
        """Get normalized Yahoo quote type."""
        return str(self.info.get("quoteType") or "").upper()

    def get_market_state(self) -> str:
        """Get normalized Yahoo market state."""
        return str(self.info.get("marketState") or "").upper()

    def get_info_float(self, key: str) -> float | None:
        """Read and parse float-like value from Yahoo info."""
        return _safe_float(self.info.get(key))

    def get_current_price(self) -> float | None:
        """Best-effort current/regular price from Yahoo info."""
        return self.get_info_float("currentPrice") or self.get_info_float("regularMarketPrice")

    def get_previous_close(self) -> float | None:
        """Best-effort previous close from Yahoo info."""
        return self.get_info_float("regularMarketPreviousClose")

    def get_realtime_price(self, market_state: str) -> float | None:
        """Pick best available realtime price from pre/regular/post values."""
        candidates = [
            (int(self.info.get(time_key) or 0), price)
            for price_key, time_key in _PRICE_TIME_KEYS
            if (price := _safe_float(self.info.get(price_key))) is not None
        ]
        if candidates and any(ts > 0 for ts, _ in candidates):
            return round(max(candidates, key=lambda x: x[0])[1], 2)

        preferred = _SESSION_PRICE_KEYS.get(market_state)
        for key in (preferred, *_PRICE_FALLBACK_ORDER):
            if key and (price := _safe_float(self.info.get(key))) is not None:
                return round(price, 2)
        return None

    def get_market_cap(self) -> float | None:
        """Get raw market cap in dollars."""
        return self.get_info_float("marketCap")

    def get_pe_trailing(self) -> float | None:
        """Get trailing PE from Yahoo info."""
        if (value := self.get_info_float("trailingPE")) is None:
            return None
        return round(value, 2)

    def get_peg(self) -> float | None:
        """Get trailing PEG ratio from Yahoo info."""
        if (value := self.get_info_float("trailingPegRatio")) is None:
            return None
        return round(value, 2)

    def get_beta(self) -> float | None:
        """Get beta using primary key then 3-year fallback."""
        value = self.get_info_float("beta") or self.get_info_float("beta3Year")
        return round(value, 2) if value is not None else None

    def get_ratio_percent(self, key: str) -> float | None:
        """Read ratio from Yahoo info and convert to percentage points."""
        ratio = self.get_info_float(key)
        return round(ratio * 100, 2) if ratio is not None else None

    def get_revenue_growth_percent(self) -> float | None:
        """Get revenue growth in percentage points."""
        return self.get_ratio_percent("revenueGrowth")

    def get_gross_margin_percent(self) -> float | None:
        """Get gross margin in percentage points."""
        return self.get_ratio_percent("grossMargins")

    def get_debt_to_equity_percent(self) -> float | None:
        """Get debt-to-equity percentage from Yahoo info."""
        value = self.get_info_float("debtToEquity")
        return round(value, 2) if value is not None else None

    def get_ytd_return_percent(self) -> float | None:
        """Get Yahoo ytdReturn and convert to percentage points."""
        return self.get_ratio_percent("ytdReturn")

    def get_free_cash_flow_in_quote_currency(self) -> float | None:
        """Get free cash flow converted into quote currency when needed."""
        fcf = self.get_info_float("freeCashflow")
        if fcf is None:
            return None
        fin_curr = str(self.info.get("financialCurrency") or "").upper()
        quote_curr = str(self.info.get("currency") or "").upper()
        if not fin_curr or not quote_curr or fin_curr == quote_curr:
            return fcf
        rate = _fx_rate(fin_curr, quote_curr)
        return fcf * rate if rate else None

    def get_forward_pe_ntm(self) -> float | None:
        """Compute forward PE using FY0/FY1 NTM blend, with FY1 fallback."""
        if self.get_quote_type() == ETF_QUOTE_TYPE:
            return None
        price = self.get_current_price()
        if price is None or price <= 0:
            return None

        eps_fy0 = self.get_info_float("epsCurrentYear")
        eps_fy1 = self.get_info_float("forwardEps")
        if eps_fy0 is not None and eps_fy1 is not None:
            weight_fy0 = _fiscal_weight_fy0(self.get_info_float("nextFiscalYearEnd"))
            if weight_fy0 is not None:
                eps_ntm = (weight_fy0 * eps_fy0) + ((1 - weight_fy0) * eps_fy1)
                if eps_ntm != 0:
                    return round(price / eps_ntm, 2)

        if eps_fy1 is not None and eps_fy1 != 0:
            return round(price / eps_fy1, 2)
        return None
