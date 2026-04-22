"""Build a Fisher-z blended correlation engine for portfolio risk sizing.

Methodology overview:
- fetch and align close-price history for the ticker universe
- derive daily, weekly, and month-end return frames
- optionally filter to down-market dates to study stress behavior
- optionally residualize returns against a market proxy to isolate non-beta co-movement
- build per-horizon and per-lookback correlation components
- blend those components in Fisher-z space
- shrink and eigen-clip the final matrix so downstream risk math sees a PSD-safe result
"""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
import json
from pathlib import Path
import sqlite3
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

HISTORY_PERIOD = "5y"
DEFAULT_TICKERS: list[str] = []
DATA_DIR = Path("data")
PORTFOLIO_JSON_PATH = DATA_DIR / "portfolio.json"
DATA_SQLITE_PATH = DATA_DIR / "stock_search.db"
TRADING_DAYS_PER_YEAR = 252
MIN_OBSERVATIONS_FOR_FISHER = 4
MIN_RESIDUAL_OBSERVATIONS = 30
ATANH_EPSILON = 1e-6
MAX_FETCH_WORKERS = 12
MARKET_PROXY_TICKER = "SPY"
PSD_EIGENVALUE_FLOOR = 1e-8
PSD_SHRINKAGE = 0.05
DEFAULT_EFFECTIVE_SLEEVE_CAP = 0.15
HORIZON_RETURN_FRAME_KEYS: dict[str, str] = {
    "daily": "daily",
    "weekly": "weekly",
    "monthly": "monthly",
}
HORIZON_MIN_OBSERVATIONS: dict[str, int] = {
    "daily": 60,
    "weekly": 26,
    "monthly": 12,
}
PERCENT_STATS_COLUMNS: tuple[str, ...] = (
    "annualized_return",
    "daily_std_dev",
    "monthly_std_dev",
    "annualized_std_dev",
)
# Placeholder until marker metadata is stored with portfolio positions.
# Example:
# "ITA": {"markers": ["sleeve:defense"]},
# "SHLD": {"markers": ["sleeve:defense"]},
TICKER_METADATA_PLACEHOLDER: dict[str, dict[str, list[str]]] = {}


def normalize_ticker_symbol(value: str) -> str:
    """Normalize ticker symbols for internal storage and lookups."""
    return str(value).upper().strip()


def _normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize ticker symbols for Yahoo Finance endpoints."""
    return normalize_ticker_symbol(ticker).replace(" ", "-").replace(".", "-")


def _load_positions_from_json(path: Path = PORTFOLIO_JSON_PATH) -> list[dict[str, Any]]:
    """Load portfolio positions from the local JSON file when present."""
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [row for row in payload if isinstance(row, dict)] if isinstance(payload, list) else []


def _load_positions_from_sqlite(path: Path = DATA_SQLITE_PATH) -> list[dict[str, Any]]:
    """Load portfolio positions from the local SQLite store when present."""
    if not path.exists():
        return []

    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT payload_json
            FROM positions
            ORDER BY sort_index ASC, ticker ASC
            """
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        with suppress(AttributeError):
            connection.close()

    positions: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            positions.append(payload)
    return positions


def load_positions() -> list[dict[str, Any]]:
    """Load positions from the remaining local portfolio stores."""
    positions = _load_positions_from_json()
    if positions:
        return positions
    return _load_positions_from_sqlite()


@dataclass(frozen=True)
class HorizonConfig:
    """Store horizon configuration values."""

    name: str
    intent_weight: float


@dataclass(frozen=True)
class LookbackConfig:
    """Store lookback configuration values."""

    years: int
    intent_weight: float


@dataclass(frozen=True)
class CorrelationInputs:
    """Bundle the aligned inputs needed for one component correlation matrix."""

    name: str
    correlation_values: np.ndarray
    pair_count_values: np.ndarray
    intent_weight: float
    min_observations: int


@dataclass(frozen=True)
class ReturnFrames:
    """Store return data at each supported horizon."""

    daily: pd.DataFrame
    weekly: pd.DataFrame
    monthly: pd.DataFrame

    def by_name(self, horizon_name: str) -> pd.DataFrame:
        """Return the return frame for one configured horizon."""
        frame_key = HORIZON_RETURN_FRAME_KEYS[horizon_name]
        return getattr(self, frame_key)


HORIZONS: tuple[HorizonConfig, ...] = (
    HorizonConfig(name="daily", intent_weight=1.0),
    HorizonConfig(name="weekly", intent_weight=3.0),
    HorizonConfig(name="monthly", intent_weight=2.0),
)
LOOKBACKS: tuple[LookbackConfig, ...] = (
    LookbackConfig(years=1, intent_weight=3.0),
    LookbackConfig(years=3, intent_weight=2.0),
    LookbackConfig(years=5, intent_weight=1.0),
)


class BlendWeightMode(StrEnum):
    """Define how horizon weights are blended."""

    RELIABILITY = "reliability"
    INTENT = "intent"
    HYBRID = "hybrid"


class CorrelationMode(StrEnum):
    """Define whether raw or market-neutral correlations are used."""

    RAW = "raw"
    MARKET_NEUTRAL = "market_neutral"


# reliability -> weight = n - 3
# intent -> weight = configured horizon intent weights only
# hybrid -> weight = (n - 3) * horizon intent weight
BLEND_WEIGHT_MODE = BlendWeightMode.HYBRID
CORRELATION_MODE = CorrelationMode.MARKET_NEUTRAL


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    """Deduplicate values while preserving the original order."""
    return list(dict.fromkeys(values))


def _load_tickers_from_portfolio(path: Path | None = None) -> list[str]:
    """Load ticker symbols from the configured portfolio store."""
    _ = path
    positions = load_positions()

    tickers: list[str] = []
    for row in positions:
        ticker = normalize_ticker_symbol(str(row.get("ticker", "")))
        if ticker:
            tickers.append(ticker)
    return _dedupe_preserve_order(tickers)


def _resolve_tickers() -> list[str]:
    """Resolve the ticker universe for the correlation run."""
    configured = [ticker for raw in DEFAULT_TICKERS if (ticker := normalize_ticker_symbol(raw))]
    if configured:
        return _dedupe_preserve_order(configured)
    return _load_tickers_from_portfolio()


def _fetch_single_ticker_history(ticker: str) -> tuple[str, pd.Series, str]:
    """Fetch one ticker's close-history series and display name."""
    ticker_symbol = normalize_ticker_symbol(ticker)
    yahoo_ticker = yf.Ticker(_normalize_yahoo_ticker(ticker_symbol))
    try:
        history = yahoo_ticker.history(period=HISTORY_PERIOD, interval="1d").copy()
    except Exception:
        return ticker_symbol, pd.Series(dtype="float64"), ticker_symbol
    price_column = "Adj Close" if "Adj Close" in history else "Close"
    if history.empty or price_column not in history:
        return ticker_symbol, pd.Series(dtype="float64"), ticker_symbol

    close_series = pd.to_numeric(history[price_column], errors="coerce").dropna()
    close_series.index = pd.to_datetime(close_series.index, utc=True)
    close_series = close_series[~close_series.index.duplicated(keep="last")]
    close_series.name = ticker_symbol

    try:
        info = yahoo_ticker.info or {}
    except Exception:
        info = {}
    short_name = str(info.get("shortName") or info.get("longName") or ticker_symbol)
    return ticker_symbol, close_series, short_name


def _build_close_matrix_and_names(tickers: list[str]) -> tuple[pd.DataFrame, dict[str, str]]:
    """Build the aligned close-price matrix and display-name map."""
    if not tickers:
        return pd.DataFrame(), {}

    close_columns: dict[str, pd.Series] = {}
    names: dict[str, str] = {}
    worker_count = max(1, min(len(tickers), MAX_FETCH_WORKERS))

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for ticker, close_series, short_name in executor.map(
            _fetch_single_ticker_history,
            tickers,
        ):
            if close_series.empty:
                continue
            close_columns[ticker] = close_series
            names[ticker] = short_name

    if not close_columns:
        return pd.DataFrame(), {}

    close_frame = pd.DataFrame(close_columns).sort_index()
    close_frame = close_frame.dropna(how="all")
    return close_frame, names


def _pair_counts(returns: pd.DataFrame, tickers: list[str]) -> pd.DataFrame:
    """Count the overlapping observations for each ticker pair."""
    valid_mask = returns.reindex(columns=tickers).notna().astype("float64")
    counts = valid_mask.T.dot(valid_mask)
    return counts.reindex(index=tickers, columns=tickers).astype("float64")


def _calculate_blended_pair_correlation(
    *,
    left_index: int,
    right_index: int,
    inputs: list[CorrelationInputs],
    blend_weight_mode: BlendWeightMode,
) -> float | None:
    """Blend one pairwise correlation across all component matrices.

    Args:
        left_index: Row index for the left ticker in the aligned correlation arrays.
        right_index: Column index for the right ticker in the aligned correlation arrays.
        inputs: Component correlation matrices plus pair-count metadata.
        blend_weight_mode: Weighting policy for reliability versus configured intent.

    Returns:
        The Fisher-z blended correlation for the ticker pair, or `None` when no
        component has enough usable observations.
    """
    weighted_sum = 0.0
    weight_total = 0.0

    for item in inputs:
        corr_value = item.correlation_values[left_index, right_index]
        pair_count = item.pair_count_values[left_index, right_index]
        if np.isnan(corr_value) or np.isnan(pair_count):
            continue
        if pair_count < item.min_observations:
            continue

        clipped = float(np.clip(corr_value, -1.0 + ATANH_EPSILON, 1.0 - ATANH_EPSILON))
        z_value = float(np.arctanh(clipped))
        reliability_weight = float(np.sqrt(max(float(pair_count) - 3.0, 0.0)))
        if blend_weight_mode == BlendWeightMode.RELIABILITY:
            final_weight = reliability_weight
        elif blend_weight_mode == BlendWeightMode.INTENT:
            final_weight = item.intent_weight
        else:
            final_weight = reliability_weight * item.intent_weight
        if final_weight <= 0:
            continue
        weighted_sum += final_weight * z_value
        weight_total += final_weight

    if weight_total <= 0:
        return None
    return float(np.tanh(weighted_sum / weight_total))


def _fisher_blended_correlation(
    tickers: list[str],
    inputs: list[CorrelationInputs],
    *,
    blend_weight_mode: BlendWeightMode,
) -> pd.DataFrame:
    """Blend per-horizon correlations in Fisher-z space.

    The blend is computed pair by pair across every horizon/lookback component.
    Correlations are converted to Fisher-z scores before averaging so the final
    blend behaves well near the correlation bounds of -1 and 1.
    """
    ticker_count = len(tickers)
    combined_values = np.full((ticker_count, ticker_count), np.nan, dtype="float64")
    np.fill_diagonal(combined_values, 1.0)

    for left_index in range(ticker_count):
        for right_index in range(left_index + 1, ticker_count):
            pair_correlation = _calculate_blended_pair_correlation(
                left_index=left_index,
                right_index=right_index,
                inputs=inputs,
                blend_weight_mode=blend_weight_mode,
            )
            if pair_correlation is None:
                continue
            combined_values[left_index, right_index] = pair_correlation
            combined_values[right_index, left_index] = pair_correlation
    return pd.DataFrame(combined_values, index=tickers, columns=tickers)


def _build_return_frames(closes: pd.DataFrame) -> ReturnFrames:
    """Build daily, weekly, and month-end return frames from aligned closes."""
    daily_returns = closes.pct_change(fill_method=None).dropna(how="all")
    weekly_returns = closes.resample("W-FRI").last().dropna(how="all").pct_change(fill_method=None).dropna(how="all")
    monthly_returns = closes.resample("ME").last().dropna(how="all").pct_change(fill_method=None).dropna(how="all")
    return ReturnFrames(
        daily=daily_returns,
        weekly=weekly_returns,
        monthly=monthly_returns,
    )


def _slice_returns_to_lookback(returns: pd.DataFrame, years: int) -> pd.DataFrame:
    """Slice returns to lookback."""
    if returns.empty:
        return returns
    end_ts = returns.index.max()
    if pd.isna(end_ts):
        return returns
    start_ts = end_ts - pd.DateOffset(years=years)
    return returns.loc[returns.index >= start_ts]


def _iter_market_aligned_arrays(
    returns: pd.DataFrame,
    market_ticker: str,
) -> Iterator[tuple[str, pd.Index, np.ndarray, np.ndarray]]:
    """Yield market-aligned return arrays for each ticker."""
    market_returns = returns[market_ticker].dropna()
    for ticker in returns.columns:
        if ticker == market_ticker:
            continue
        ticker_returns = returns[ticker].dropna()
        aligned_index = market_returns.index.intersection(ticker_returns.index)
        if len(aligned_index) < MIN_RESIDUAL_OBSERVATIONS:
            continue

        aligned_market = market_returns.loc[aligned_index].to_numpy(dtype="float64")
        aligned_ticker = ticker_returns.loc[aligned_index].to_numpy(dtype="float64")
        yield ticker, aligned_index, aligned_ticker, aligned_market


def _residualize_returns(returns: pd.DataFrame, market_ticker: str) -> pd.DataFrame:
    """Remove market beta from each ticker's return series.

    Each ticker is regressed against the market proxy over overlapping dates, and
    the residual return series is kept. The result is a market-neutralized return
    frame that emphasizes co-movement beyond broad market beta.
    """
    if returns.empty or market_ticker not in returns.columns:
        return pd.DataFrame(index=returns.index)

    residual_series_by_ticker: dict[str, pd.Series] = {}
    for ticker, aligned_index, aligned_ticker, aligned_market in _iter_market_aligned_arrays(
        returns,
        market_ticker,
    ):
        centered_market = aligned_market - aligned_market.mean()
        market_sum_squares = float(centered_market @ centered_market)
        if market_sum_squares <= 0:
            continue

        centered_ticker = aligned_ticker - aligned_ticker.mean()
        beta = float((centered_ticker @ centered_market) / market_sum_squares)
        alpha = aligned_ticker.mean() - beta * aligned_market.mean()
        residual_values = aligned_ticker - (alpha + beta * aligned_market)
        residual_series_by_ticker[ticker] = pd.Series(residual_values, index=aligned_index)

    if not residual_series_by_ticker:
        return pd.DataFrame(index=returns.index)
    return pd.DataFrame(residual_series_by_ticker).sort_index().dropna(how="all")


def _estimate_market_betas(returns: pd.DataFrame, market_ticker: str) -> dict[str, float]:
    """Estimate market betas."""
    if returns.empty or market_ticker not in returns.columns:
        return {}

    betas: dict[str, float] = {}
    for ticker, _aligned_index, aligned_ticker, aligned_market in _iter_market_aligned_arrays(
        returns,
        market_ticker,
    ):
        centered_market = aligned_market - aligned_market.mean()
        market_sum_squares = float(centered_market @ centered_market)
        if market_sum_squares <= 0:
            continue

        centered_ticker = aligned_ticker - aligned_ticker.mean()
        betas[ticker] = float((centered_ticker @ centered_market) / market_sum_squares)
    return betas


def _build_blended_matrix(
    closes: pd.DataFrame,
    tickers: list[str],
    horizons: tuple[HorizonConfig, ...],
    lookbacks: tuple[LookbackConfig, ...],
    *,
    blend_weight_mode: BlendWeightMode,
    correlation_mode: CorrelationMode,
    market_proxy_ticker: str | None = None,
    tail_market_ticker: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """Build raw and PSD-safe blended correlation matrices.

    Args:
        closes: Aligned close-price matrix for the correlation universe.
        tickers: Portfolio tickers to keep in the final matrices.
        horizons: Configured return horizons such as daily, weekly, and monthly.
        lookbacks: Configured lookback windows that produce separate components.
        blend_weight_mode: Policy for combining reliability and intent weights.
        correlation_mode: Whether to use raw or market-neutralized return series.
        market_proxy_ticker: Market proxy used for optional beta residualization.
        tail_market_ticker: Market proxy used to filter to down-market dates.

    Returns:
        A tuple of:
        - the raw Fisher-z blended matrix
        - the PSD-safe matrix used for downstream sizing and reporting
        - diagnostics describing the component set and PSD repair step
    """
    return_frames = _build_return_frames(closes)
    source_inputs: list[CorrelationInputs] = []
    component_diagnostics: dict[str, dict[str, float | int]] = {}
    for horizon in horizons:
        full_horizon_returns = return_frames.by_name(horizon.name)
        if tail_market_ticker:
            market_returns = full_horizon_returns.get(tail_market_ticker)
            full_horizon_returns = full_horizon_returns.iloc[0:0] if market_returns is None else full_horizon_returns.loc[market_returns < 0.0]
        if correlation_mode == CorrelationMode.MARKET_NEUTRAL and market_proxy_ticker:
            full_horizon_returns = _residualize_returns(full_horizon_returns, market_proxy_ticker)
        min_observations = HORIZON_MIN_OBSERVATIONS.get(
            horizon.name,
            MIN_OBSERVATIONS_FOR_FISHER,
        )
        for lookback in lookbacks:
            horizon_returns = _slice_returns_to_lookback(full_horizon_returns, lookback.years)
            horizon_returns = horizon_returns.reindex(columns=tickers)
            if horizon_returns.empty or not horizon_returns.notna().any().any():
                continue
            combined_intent_weight = horizon.intent_weight * lookback.intent_weight
            component_name = f"{horizon.name}_{lookback.years}y"
            source_inputs.append(
                CorrelationInputs(
                    name=component_name,
                    correlation_values=(horizon_returns.corr().reindex(index=tickers, columns=tickers).to_numpy(dtype="float64")),
                    pair_count_values=_pair_counts(horizon_returns, tickers).to_numpy(dtype="float64"),
                    intent_weight=combined_intent_weight,
                    min_observations=min_observations,
                )
            )
            component_diagnostics[component_name] = {
                "rows": len(horizon_returns),
                "horizon_intent_weight": horizon.intent_weight,
                "lookback_intent_weight": lookback.intent_weight,
                "combined_intent_weight": combined_intent_weight,
                "min_observations": min_observations,
            }
    diagnostics: dict[str, Any] = {
        "components": component_diagnostics,
        "blend_weight_mode": blend_weight_mode.value,
        "correlation_mode": correlation_mode.value,
    }

    raw_blended_matrix = _fisher_blended_correlation(
        tickers=tickers,
        inputs=source_inputs,
        blend_weight_mode=blend_weight_mode,
    )
    filled_blended_matrix = raw_blended_matrix.fillna(0.0)
    symmetric_values = ((filled_blended_matrix + filled_blended_matrix.T) / 2.0).to_numpy(dtype="float64")
    shrunk_values = (1.0 - PSD_SHRINKAGE) * symmetric_values + PSD_SHRINKAGE * np.eye(len(tickers))
    eigenvalues, _ = np.linalg.eigh(symmetric_values)
    shrunk_eigenvalues, shrunk_eigenvectors = np.linalg.eigh(shrunk_values)
    clipped_eigenvalues = np.clip(shrunk_eigenvalues, PSD_EIGENVALUE_FLOOR, None)
    psd_values = (shrunk_eigenvectors * clipped_eigenvalues) @ shrunk_eigenvectors.T
    scale = np.sqrt(np.clip(np.diag(psd_values), PSD_EIGENVALUE_FLOOR, None))
    normalized_psd_values = psd_values / np.outer(scale, scale)
    normalized_psd_values = np.clip(normalized_psd_values, -1.0, 1.0)
    np.fill_diagonal(normalized_psd_values, 1.0)
    diagnostics["matrix_shrinkage"] = PSD_SHRINKAGE
    diagnostics["matrix_min_eigenvalue_raw"] = float(np.min(eigenvalues))
    diagnostics["matrix_min_eigenvalue_shrunk"] = float(np.min(shrunk_eigenvalues))
    diagnostics["matrix_min_eigenvalue_psd"] = float(np.min(clipped_eigenvalues))
    psd_blended_matrix = pd.DataFrame(
        normalized_psd_values,
        index=tickers,
        columns=tickers,
    )
    return raw_blended_matrix, psd_blended_matrix, diagnostics


def _annualized_return(daily_returns: pd.Series) -> float | None:
    """Annualize the mean return of a return series."""
    clean = daily_returns.dropna()
    if clean.empty:
        return None
    clean_values = clean.to_numpy(dtype="float64")
    if np.any(clean_values <= -1.0):
        return None
    log_growth = np.log1p(clean_values).sum()
    time_span = clean.index.max() - clean.index.min()
    years = time_span / pd.Timedelta(days=365.25)
    if years <= 0:
        return None
    return float(np.expm1(log_growth / years))


def _per_ticker_stats(closes: pd.DataFrame, names: dict[str, str]) -> pd.DataFrame:
    """Build per-ticker return and volatility summary statistics."""
    return_frames = _build_return_frames(closes)
    daily_returns = return_frames.daily
    monthly_returns = return_frames.monthly
    rows: list[dict[str, Any]] = []

    for ticker in closes.columns:
        ticker_daily = daily_returns[ticker]
        daily_std = float(ticker_daily.std()) if ticker_daily.notna().any() else None
        ticker_monthly = monthly_returns[ticker]
        monthly_std = float(ticker_monthly.std()) if ticker_monthly.notna().any() else None
        annualized_std = daily_std * np.sqrt(TRADING_DAYS_PER_YEAR) if daily_std is not None else None

        rows.append(
            {
                "name": names.get(ticker, ticker),
                "ticker": ticker,
                "annualized_return": _annualized_return(ticker_daily),
                "daily_std_dev": daily_std,
                "monthly_std_dev": monthly_std,
                "annualized_std_dev": annualized_std,
            }
        )

    return pd.DataFrame(rows)


def _as_percent(value: float | None) -> str:
    """Convert a decimal ratio into percentage points."""
    if value is None or pd.isna(value):
        return "n/a"
    return f"{value * 100.0:.2f}%"


def _resolve_ticker_markers(ticker: str) -> list[str]:
    """Resolve ticker markers."""
    markers = TICKER_METADATA_PLACEHOLDER.get(ticker, {}).get("markers", [])
    return markers if isinstance(markers, list) else []


def _mean_pair_correlation(correlation_matrix: pd.DataFrame, members: list[str]) -> float:
    """Return the average off-diagonal pair correlation."""
    if len(members) < 2:
        return 0.0
    subset = correlation_matrix.reindex(index=members, columns=members)
    mask = ~np.eye(len(members), dtype=bool)
    values = subset.to_numpy(dtype="float64")[mask]
    finite_values = values[np.isfinite(values)]
    if len(finite_values) == 0:
        return 0.0
    return float(np.clip(np.mean(finite_values), -0.99, 0.99))


def _build_sleeve_weight_recommendations(
    *,
    tickers: list[str],
    normal_correlation_matrix: pd.DataFrame,
    tail_raw_correlation_matrix: pd.DataFrame | None = None,
    effective_sleeve_cap: float = DEFAULT_EFFECTIVE_SLEEVE_CAP,
) -> list[dict[str, Any]]:
    """Build sleeve-cap recommendations from normal and optional tail matrices.

    The sizing rule is deliberately conservative: when a tail raw matrix is
    available, the sleeve cap uses the higher of normal-time and down-market
    mean pair correlation. The goal is to keep risk caps anchored to the regime
    where diversification usually weakens most.
    """
    members_by_marker: dict[str, list[str]] = {}
    for ticker in tickers:
        for marker in _resolve_ticker_markers(ticker):
            marker_key = str(marker).strip().lower()
            if not marker_key:
                continue
            members_by_marker.setdefault(marker_key, []).append(ticker)

    recommendations: list[dict[str, Any]] = []
    for marker in sorted(members_by_marker):
        members = _dedupe_preserve_order(members_by_marker[marker])
        if len(members) < 2:
            continue

        member_count = len(members)
        normal_mean_correlation = _mean_pair_correlation(
            normal_correlation_matrix,
            members,
        )
        tail_raw_mean_correlation = (
            _mean_pair_correlation(
                tail_raw_correlation_matrix,
                members,
            )
            if tail_raw_correlation_matrix is not None and not tail_raw_correlation_matrix.empty
            else None
        )
        effective_mean_correlation = max(normal_mean_correlation, tail_raw_mean_correlation) if tail_raw_mean_correlation is not None else normal_mean_correlation
        variance_ratio = (1.0 + (member_count - 1) * effective_mean_correlation) / member_count
        diversification_multiplier = float(np.sqrt(max(variance_ratio, 0.0)))
        if diversification_multiplier <= 0:
            continue

        max_total_weight = float(np.clip(effective_sleeve_cap / diversification_multiplier, 0.0, 1.0))
        recommended_member_weight = max_total_weight / member_count
        correlation_basis = "tail_raw" if tail_raw_mean_correlation is not None and tail_raw_mean_correlation >= normal_mean_correlation else "normal"
        recommendations.append(
            {
                "marker": marker,
                "members": members,
                "member_count": member_count,
                "mean_pair_correlation": effective_mean_correlation,
                "normal_mean_pair_correlation": normal_mean_correlation,
                "tail_mean_pair_correlation": tail_raw_mean_correlation,
                "correlation_basis": correlation_basis,
                "effective_sleeve_cap": effective_sleeve_cap,
                "diversification_multiplier": diversification_multiplier,
                "recommended_total_weight": max_total_weight,
                "recommended_member_weight_equal": recommended_member_weight,
            }
        )
    return recommendations


def main() -> dict[str, Any]:
    """Run the correlation report's CLI entrypoint.

    Returns:
        A dictionary containing:
        - normal-time raw and PSD-safe correlation matrices
        - down-market raw and PSD-safe correlation matrices when available
        - per-ticker risk/return summary stats
        - sleeve sizing recommendations driven by the more conservative of
          normal and tail raw co-movement
        - diagnostics about the blended components and PSD repair step
    """
    portfolio_tickers = _resolve_tickers()
    if not portfolio_tickers:
        raise ValueError("No tickers found. Set DEFAULT_TICKERS or add positions to the local portfolio store.")
    market_ticker = normalize_ticker_symbol(MARKET_PROXY_TICKER)
    fetch_tickers = portfolio_tickers.copy()
    if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL and market_ticker:
        fetch_tickers.append(market_ticker)
    fetch_tickers = _dedupe_preserve_order(fetch_tickers)

    closes, names = _build_close_matrix_and_names(fetch_tickers)
    if closes.empty:
        raise ValueError("No valid close price history available for requested tickers.")

    active_tickers = [ticker for ticker in portfolio_tickers if ticker in closes.columns]
    if not active_tickers:
        raise ValueError("No valid close price history available for requested tickers.")

    correlation_tickers = active_tickers.copy()
    if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL and market_ticker and market_ticker in closes.columns:
        correlation_tickers.append(market_ticker)

    correlation_closes = closes.reindex(columns=correlation_tickers).dropna(how="all")
    stats_closes = closes.reindex(columns=active_tickers).dropna(how="all")
    blend_market_ticker = market_ticker if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL else None
    blend_kwargs = {
        "closes": correlation_closes,
        "tickers": active_tickers,
        "horizons": HORIZONS,
        "lookbacks": LOOKBACKS,
        "blend_weight_mode": BLEND_WEIGHT_MODE,
        "correlation_mode": CORRELATION_MODE,
        "market_proxy_ticker": blend_market_ticker,
    }
    normal_raw_matrix, normal_psd_matrix, diagnostics = _build_blended_matrix(**blend_kwargs)
    tail_raw_matrix = pd.DataFrame()
    tail_psd_matrix = pd.DataFrame()
    if market_ticker and market_ticker in correlation_closes.columns:
        tail_raw_matrix, tail_psd_matrix, tail_diagnostics = _build_blended_matrix(
            **blend_kwargs,
            tail_market_ticker=market_ticker,
        )
        diagnostics["tail"] = tail_diagnostics
    if blend_market_ticker:
        daily_returns = _build_return_frames(correlation_closes).daily
        diagnostics["market_betas"] = _estimate_market_betas(
            daily_returns,
            blend_market_ticker,
        )
    stats = _per_ticker_stats(stats_closes, names)
    stats_percent = stats.assign(**{column: stats[column].apply(_as_percent) for column in PERCENT_STATS_COLUMNS})
    sleeve_weight_recommendations = _build_sleeve_weight_recommendations(
        tickers=active_tickers,
        normal_correlation_matrix=normal_psd_matrix,
        tail_raw_correlation_matrix=tail_raw_matrix,
    )
    return {
        "tickers": active_tickers,
        "normal_matrix_raw": normal_raw_matrix,
        "normal_matrix_psd": normal_psd_matrix,
        "normal_matrix_rounded": normal_psd_matrix.round(2),
        "tail_matrix_psd": tail_psd_matrix,
        "tail_matrix_raw": tail_raw_matrix,
        "sleeve_weight_recommendations": sleeve_weight_recommendations,
        "stats": stats,
        "stats_percent": stats_percent,
        "diagnostics": diagnostics,
    }
