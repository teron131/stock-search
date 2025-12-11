#!/usr/bin/env python3
"""
Test script to fetch analyst rating data from yfinance and store in pandas
"""

from datetime import UTC, datetime, timedelta

import pandas as pd
import yfinance as yf


def get_analyst_ratings(ticker: str) -> pd.DataFrame:
    """
    Fetch analyst rating data for a given ticker using yfinance

    Args:
        ticker: Stock ticker symbol (e.g., 'NVDA')

    Returns:
        pandas DataFrame containing analyst ratings
    """
    # Download stock data using yfinance
    stock = yf.Ticker(ticker)

    # Get analyst ratings - yfinance provides info attribute with analyst recommendations
    print(f"\n{'=' * 60}")
    print(f"Fetching analyst ratings for {ticker}")
    print(f"{'=' * 60}")

    # Method 1: Using info dict which includes analyst data
    info = stock.info

    # Extract analyst rating information
    analyst_data = {}

    # Key analyst metrics available in yfinance
    analyst_keys = [
        "recommendationKey",  # e.g., 'buy', 'strong-buy', 'hold', 'sell', 'strong-sell'
        "recommendationRating",
        "numberOfAnalysts",
        "targetMeanPrice",
        "targetMedianPrice",
        "targetHighPrice",
        "targetLowPrice",
    ]

    for key in analyst_keys:
        if key in info:
            analyst_data[key] = info.get(key)

    # Create a DataFrame from the analyst data
    df_analyst = pd.DataFrame([analyst_data])

    print("\nAnalyst Ratings Data:")
    print(df_analyst.to_string())

    return df_analyst


def get_analyst_ratings_detailed(ticker: str) -> pd.DataFrame:
    """
    Alternative method to get more comprehensive analyst data
    """
    stock = yf.Ticker(ticker)
    info = stock.info

    # Create a more detailed dataframe
    rating_data = {
        "Ticker": ticker,
        "Recommendation": info.get("recommendationKey", "N/A"),
        "Number of Analysts": info.get("numberOfAnalysts", "N/A"),
        "Target Mean Price": info.get("targetMeanPrice", "N/A"),
        "Target Median Price": info.get("targetMedianPrice", "N/A"),
        "Target High Price": info.get("targetHighPrice", "N/A"),
        "Target Low Price": info.get("targetLowPrice", "N/A"),
        "Current Price": info.get("currentPrice", "N/A"),
    }

    df = pd.DataFrame([rating_data])
    return df


def get_recent_analyst_upside(ticker: str, days: int = 90) -> dict:
    """
    Get recent analyst ratings (within N days) and calculate average upside

    Args:
        ticker: Stock ticker symbol
        days: Number of days to look back (default 90)

    Returns:
        Dictionary containing analyst upside analysis
    """
    stock = yf.Ticker(ticker)
    current_price = stock.info.get("currentPrice")

    # Get upgrades/downgrades which includes dates and price targets
    try:
        upgrades_df = stock.upgrades_downgrades
    except Exception:
        print(f"Could not retrieve upgrades/downgrades for {ticker}")
        return None

    if upgrades_df is None or upgrades_df.empty:
        print(f"No upgrades/downgrades data available for {ticker}")
        return None

    # Convert index to datetime if not already
    upgrades_df.index = pd.to_datetime(upgrades_df.index)

    # Calculate cutoff date (90 days ago)
    cutoff_date = datetime.now(UTC) - timedelta(days=days)

    # Filter for recent analyst ratings
    recent_ratings = upgrades_df[upgrades_df.index >= cutoff_date].copy()

    if recent_ratings.empty:
        print(f"No analyst ratings within the last {days} days for {ticker}")
        return None

    # Calculate upside for each rating
    # Upside % = (Target Price - Current Price) / Current Price * 100
    recent_ratings["Upside %"] = (recent_ratings["currentPriceTarget"] - current_price) / current_price * 100

    # Round upside to 2 decimal places
    recent_ratings["Upside %"] = recent_ratings["Upside %"].round(2)

    # Calculate average upside
    average_upside = recent_ratings["Upside %"].mean()

    result = {
        "ticker": ticker,
        "current_price": current_price,
        "days_lookback": days,
        "num_recent_ratings": len(recent_ratings),
        "average_upside_pct": round(average_upside, 2),
        "max_upside_pct": recent_ratings["Upside %"].max(),
        "min_upside_pct": recent_ratings["Upside %"].min(),
        "median_upside_pct": recent_ratings["Upside %"].median(),
        "recent_ratings_df": recent_ratings,
    }

    return result


if __name__ == "__main__":
    # Test on NVDA
    ticker = "NVDA"

    # Method 1: Basic analyst ratings
    df1 = get_analyst_ratings(ticker)

    # Method 2: More detailed view
    print(f"\n{'=' * 60}")
    print("Detailed Analyst Ratings View:")
    print(f"{'=' * 60}")
    df2 = get_analyst_ratings_detailed(ticker)
    print(df2.to_string())

    # Method 3: Recent analyst upside analysis (last 90 days)
    print(f"\n{'=' * 60}")
    print("Recent Analyst Ratings (Last 90 Days):")
    print(f"{'=' * 60}")
    upside_analysis = get_recent_analyst_upside(ticker, days=90)

    if upside_analysis:
        print(f"\nTicker: {upside_analysis['ticker']}")
        print(f"Current Price: ${upside_analysis['current_price']:.2f}")
        print(f"Number of Recent Ratings: {upside_analysis['num_recent_ratings']}")
        print("\nUpside Analysis:")
        print(f"  Average Upside: {upside_analysis['average_upside_pct']:.2f}%")
        print(f"  Median Upside: {upside_analysis['median_upside_pct']:.2f}%")
        print(f"  Max Upside: {upside_analysis['max_upside_pct']:.2f}%")
        print(f"  Min Upside: {upside_analysis['min_upside_pct']:.2f}%")

        print(f"\n{'=' * 60}")
        print("Detailed Recent Ratings:")
        print(f"{'=' * 60}")
        detailed_df = upside_analysis["recent_ratings_df"][["Firm", "Action", "currentPriceTarget", "priorPriceTarget", "Upside %"]].copy()
        detailed_df.columns = ["Firm", "Action", "Target Price", "Prior Target", "Upside %"]
        print(detailed_df.to_string())
