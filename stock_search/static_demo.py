"""Export bundled JSON payloads for the static README demo."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import random
from typing import Any

from stock_search.api.config import DATA_SQLITE_PATH, RAW_UI_DIR
from stock_search.data_sources.stockanalysis import get_industry_snapshot_async
from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.news.orchestrator import get_news_async
from stock_search.sqlite_store import SQLiteStore

logger = logging.getLogger(__name__)

DEMO_OUTPUT_DIR = RAW_UI_DIR / "public" / "demo"
DEMO_RANDOM_SEED = 20260418
DEMO_POSITION_COUNT_RANGE = (14, 20)
DEMO_BUCKETS = ("Core", "Satellite", "Speculation", "Defense")
DEMO_NEWS_MAX_RESULTS = 5
DEMO_NEWS_CONCURRENCY = 3


def _safe_float(value: Any) -> float | None:
    """Return a float when the input is numeric-like."""
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return None if numeric != numeric else numeric


def _weighted_average(rows: list[dict[str, Any]], field_name: str) -> float | None:
    """Compute a total-weighted average for one numeric row field."""
    weighted_total = 0.0
    weight_sum = 0.0
    for row in rows:
        total = _safe_float(row.get("total"))
        value = _safe_float(row.get(field_name))
        if total is None or total <= 0 or value is None:
            continue
        weighted_total += total * value
        weight_sum += total
    if weight_sum <= 0:
        return None
    return weighted_total / weight_sum


def _random_quantity(price: float, rng: random.Random) -> int:
    """Return a realistic share count for the given price bucket."""
    if price >= 1000:
        return rng.randint(8, 36)
    if price >= 500:
        return rng.randint(12, 64)
    if price >= 200:
        return rng.randint(20, 140)
    if price >= 100:
        return rng.randint(36, 240)
    if price >= 50:
        return rng.randint(60, 360)
    if price >= 20:
        return rng.randint(90, 640)
    return rng.randint(150, 1200)


def _pick_demo_holdings(
    stocks_map: dict[str, dict[str, Any]],
    *,
    seed: int,
) -> dict[str, dict[str, Any]]:
    """Select demo holdings and assign seeded random share counts."""
    rng = random.Random(seed)
    candidates: list[tuple[float, str, float, str | None]] = []

    for ticker, stock_row in stocks_map.items():
        if not isinstance(stock_row, dict):
            continue
        indicators = stock_row.get("indicators")
        evaluation = stock_row.get("evaluation")
        if not isinstance(indicators, dict) or not isinstance(evaluation, dict):
            continue
        price = _safe_float(indicators.get("price"))
        overall_score = _safe_float(evaluation.get("overall_score"))
        if price is None or price <= 0 or overall_score is None:
            continue
        strategy = indicators.get("strategy")
        strategy_name = str(strategy).strip() if isinstance(strategy, str) else None
        candidates.append((overall_score, ticker, price, strategy_name))

    if not candidates:
        return {}

    candidates.sort(key=lambda item: item[0], reverse=True)
    ranked_pool = candidates[: min(len(candidates), 36)]
    min_positions, max_positions = DEMO_POSITION_COUNT_RANGE
    target_count = min(len(ranked_pool), rng.randint(min_positions, max_positions))
    selected = rng.sample(ranked_pool, k=target_count)

    holdings: dict[str, dict[str, Any]] = {}
    for _, ticker, price, strategy in selected:
        holdings[ticker] = {
            "quantity": float(_random_quantity(price, rng)),
            "strategy": strategy or rng.choice(DEMO_BUCKETS),
        }
    return holdings


def _build_demo_rows(
    stocks_map: dict[str, dict[str, Any]],
    *,
    generated_at: str,
    seed: int,
) -> dict[str, Any]:
    """Build the static dashboard payload from generated stats plus randomized shares."""
    holdings = _pick_demo_holdings(stocks_map, seed=seed)
    rows: list[dict[str, Any]] = []

    for ticker in sorted(stocks_map):
        stock_row = stocks_map.get(ticker)
        if not isinstance(stock_row, dict):
            continue
        indicators = dict(stock_row.get("indicators") or {})
        evaluation = dict(stock_row.get("evaluation") or {})
        position = holdings.get(ticker, {})

        merged: dict[str, Any] = {**indicators}
        for key, value in evaluation.items():
            if merged.get(key) is None:
                merged[key] = value

        quantity = float(position.get("quantity") or 0.0)
        price = _safe_float(merged.get("price"))
        total = round(price * quantity, 2) if price is not None and quantity > 0 else 0.0

        merged["ticker"] = ticker
        merged["name"] = merged.get("name") or ticker
        merged["quantity"] = quantity
        merged["total"] = total
        merged["strategy"] = position.get("strategy") or merged.get("strategy") or "Speculation"
        rows.append(merged)

    held_rows = [row for row in rows if _safe_float(row.get("quantity")) not in (None, 0.0)]
    total_value = sum(float(_safe_float(row.get("total")) or 0.0) for row in held_rows)

    for row in rows:
        row_total = float(_safe_float(row.get("total")) or 0.0)
        row["weight_pct"] = (row_total / total_value) * 100 if total_value > 0 else 0.0

    rows.sort(key=lambda row: float(_safe_float(row.get("weight_pct")) or 0.0), reverse=True)

    change_absolute = 0.0
    for row in held_rows:
        change_percent = float(_safe_float(row.get("change_percent_1d")) or 0.0)
        row_total = float(_safe_float(row.get("total")) or 0.0)
        change_absolute += ((change_percent / 100.0) * row_total) / (1.0 + (change_percent / 100.0))

    prior_total = total_value - change_absolute
    change_percent = (change_absolute / prior_total) * 100 if prior_total > 0 else 0.0
    weighted_beta = _weighted_average(held_rows, "beta")
    weighted_iv = _weighted_average(held_rows, "iv")

    return {
        "rows": rows,
        "portfolio_stats": {
            "total": round(total_value, 2),
            "change": round(change_absolute, 2),
            "change_percent": round(change_percent, 2),
            "held_positions_count": len(held_rows),
            "weighted_beta": round(weighted_beta, 4) if weighted_beta is not None else None,
            "weighted_iv": round(weighted_iv, 4) if weighted_iv is not None else None,
            "sector_distribution": [],
        },
        "meta": {
            "generated_at": generated_at,
            "data_source": "demo",
        },
    }


def _get_demo_news_tickers(portfolio_payload: dict[str, Any]) -> list[str]:
    """Return held demo tickers in descending portfolio weight order."""
    tickers: list[str] = []
    for row in portfolio_payload.get("rows", []):
        if not isinstance(row, dict):
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        quantity = _safe_float(row.get("quantity"))
        if not ticker or quantity is None or quantity <= 0:
            continue
        tickers.append(ticker)
    return tickers


def _build_color_standards_payload() -> dict[str, Any]:
    """Return the static color standards payload used by the UI."""
    return {
        "standards": {
            "market_cap": {"min": MarketCapConfig.MIN, "max": MarketCapConfig.MAX},
            "pe": {
                "min": CalibrationConfig.TRAILING_PE_RANGE[0],
                "max": CalibrationConfig.TRAILING_PE_RANGE[2],
            },
            "pe_forward": {
                "min": CalibrationConfig.FORWARD_PE_RANGE[0],
                "max": CalibrationConfig.FORWARD_PE_RANGE[2],
            },
            "peg": {
                "min": CalibrationConfig.PEG_RANGE[0],
                "max": CalibrationConfig.PEG_RANGE[2],
            },
            "revenue_growth": {
                "min": CalibrationConfig.REVENUE_GROWTH_PCT_RANGE[0],
                "max": CalibrationConfig.REVENUE_GROWTH_PCT_RANGE[2],
            },
            "gross_margin": {
                "min": CalibrationConfig.GROSS_MARGIN_PCT_RANGE[0],
                "max": CalibrationConfig.GROSS_MARGIN_PCT_RANGE[2],
            },
            "debt_to_equity": {
                "min": CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE[0],
                "max": CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE[2],
            },
            "median_upside": {
                "min": CalibrationConfig.UPSIDE_RANGE[0],
                "max": CalibrationConfig.UPSIDE_RANGE[2],
            },
            "bull_probability": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "bear_probability": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "rsi": {"min": 20.0, "max": 80.0},
            "overall_score": {"min": 2.0, "max": 8.0},
            "quality_score": {"min": 2.0, "max": 8.0},
            "valuation_score": {"min": 2.0, "max": 8.0},
            "moat_score": {"min": 2.0, "max": 8.0},
            "upside_score": {"min": 2.0, "max": 8.0},
        }
    }


async def _build_industries_payload() -> dict[str, Any]:
    """Fetch a market-wide industry snapshot for the static demo."""
    snapshot = await get_industry_snapshot_async()
    industries = [industry.model_dump() for industry in snapshot.industries]
    sector_count = len({str(industry.get("sector") or "").strip() for industry in industries if industry.get("sector")})
    fetched_at = datetime.now(tz=UTC).isoformat() if industries else None
    return {
        "industries": industries,
        "meta": {
            "source": "stockanalysis",
            "fetched_at": fetched_at,
            "sector_count": sector_count,
            "industry_count": len(industries),
        },
    }


async def _build_news_payload(
    tickers: list[str],
    *,
    generated_at: str,
) -> dict[str, Any]:
    """Fetch real ticker news for the static demo portfolio."""
    if not tickers:
        return {
            "meta": {"generated_at": generated_at},
            "items_by_ticker": {},
        }

    semaphore = asyncio.Semaphore(DEMO_NEWS_CONCURRENCY)

    async def fetch_ticker_news(ticker: str) -> tuple[str, list[dict[str, Any]]]:
        async with semaphore:
            try:
                news_items = await get_news_async(
                    ticker=ticker,
                    max_results=DEMO_NEWS_MAX_RESULTS,
                )
            except Exception:
                logger.exception(f"Failed to refresh static news snapshot for {ticker}.")
                return ticker, []
            return ticker, [news_item.model_dump(mode="json") for news_item in news_items]

    items_by_ticker = dict(await asyncio.gather(*(fetch_ticker_news(ticker) for ticker in tickers)))
    return {
        "meta": {"generated_at": generated_at},
        "items_by_ticker": items_by_ticker,
    }


async def _build_async_demo_payloads(
    demo_news_tickers: list[str],
    *,
    generated_at: str,
) -> dict[str, dict[str, Any]]:
    """Fetch async-backed static demo payloads together."""
    industries_task = asyncio.create_task(_build_industries_payload())
    news_task = asyncio.create_task(
        _build_news_payload(
            demo_news_tickers,
            generated_at=generated_at,
        )
    )
    industries_payload, news_payload = await asyncio.gather(
        industries_task,
        news_task,
        return_exceptions=True,
    )
    payloads: dict[str, dict[str, Any]] = {}
    if not isinstance(industries_payload, Exception):
        payloads["industries"] = industries_payload
    else:
        logger.exception("Failed to refresh static industry snapshot.", exc_info=industries_payload)
    if not isinstance(news_payload, Exception):
        payloads["news"] = news_payload
    else:
        logger.exception("Failed to refresh static news snapshot.", exc_info=news_payload)
    return payloads


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    """Serialize one static demo payload to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_static_demo_snapshot(
    *,
    stocks_map: dict[str, dict[str, Any]] | None = None,
    generated_at: str | None = None,
    output_dir: Path = DEMO_OUTPUT_DIR,
    seed: int = DEMO_RANDOM_SEED,
) -> dict[str, Path]:
    """Write the static demo JSON payloads used by GitHub Pages."""
    resolved_generated_at = generated_at or datetime.now(tz=UTC).isoformat()
    resolved_stocks_map = stocks_map or SQLiteStore(DATA_SQLITE_PATH).load_stocks()

    portfolio_payload = _build_demo_rows(
        resolved_stocks_map,
        generated_at=resolved_generated_at,
        seed=seed,
    )
    color_payload = _build_color_standards_payload()
    demo_news_tickers = _get_demo_news_tickers(portfolio_payload)

    written_paths = {
        "portfolio": output_dir / "portfolio.json",
        "color_standards": output_dir / "color-standards.json",
        "industries": output_dir / "industries.json",
        "news": output_dir / "news.json",
    }

    _write_json(written_paths["portfolio"], portfolio_payload)
    _write_json(written_paths["color_standards"], color_payload)

    async_payloads = asyncio.run(
        _build_async_demo_payloads(
            demo_news_tickers,
            generated_at=resolved_generated_at,
        )
    )
    for payload_name, payload in async_payloads.items():
        _write_json(written_paths[payload_name], payload)

    return written_paths


if __name__ == "__main__":
    for name, path in write_static_demo_snapshot().items():
        print(f"{name}: {path}")
