from fastapi import APIRouter, Response

from stock_search.api.config import EVAL_PATH
from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.file_utils import load_json
from stock_search.indicators import StockIndicator

router = APIRouter()


@router.get("/api/eval")
def eval_api(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return load_json(EVAL_PATH, default={})


@router.get("/api/color-standards")
def color_standards_api(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
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


@router.get("/api/news/{ticker}")
def news_api(ticker: str) -> list[dict]:
    return [
        {
            "title": f"Strategic analysis of {ticker} performance",
            "url": f"https://example.com/{ticker}-news-1",
            "summary": f"A deep dive into {ticker}'s latest quarterly results and future outlook.",
            "relevancy": "high",
            "category": "company_news",
            "sentiment": "bullish",
        },
        {
            "title": f"Market trends affecting {ticker}",
            "url": f"https://example.com/{ticker}-news-2",
            "summary": f"Recent sector rotation and macroeconomic factors impacting {ticker}.",
            "relevancy": "medium",
            "category": "market_news",
            "sentiment": "neutral",
        },
    ]


@router.get("/api/evaluate/{ticker}")
def evaluate_ticker_api(ticker: str) -> dict:
    indicator = StockIndicator(ticker)

    return {
        "ticker": ticker.upper(),
        "rank": 1,
        "overall_score": 8.5,
        "moat_score": 9.0,
        "quality_score": 8.0,
        "valuation_score": 7.5,
        "upside_score": 10.0,
        "market_cap_score": 9.0,
        "bull_probability": 0.7,
        "bear_probability": 0.2,
        "price": indicator.price,
        "change_percent": indicator.change_percent,
        "rsi": indicator.rsi,
    }
