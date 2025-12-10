#!/usr/bin/env python3
"""
Test script to fetch analyst rating data from yfinance and store in pandas
"""

import yfinance as yf
import pandas as pd

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
    print(f"\n{'='*60}")
    print(f"Fetching analyst ratings for {ticker}")
    print(f"{'='*60}")

    # Method 1: Using info dict which includes analyst data
    info = stock.info

    # Extract analyst rating information
    analyst_data = {}

    # Key analyst metrics available in yfinance
    analyst_keys = [
        'recommendationKey',  # e.g., 'buy', 'strong-buy', 'hold', 'sell', 'strong-sell'
        'recommendationRating',
        'numberOfAnalysts',
        'targetMeanPrice',
        'targetMedianPrice',
        'targetHighPrice',
        'targetLowPrice',
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
        'Ticker': ticker,
        'Recommendation': info.get('recommendationKey', 'N/A'),
        'Number of Analysts': info.get('numberOfAnalysts', 'N/A'),
        'Target Mean Price': info.get('targetMeanPrice', 'N/A'),
        'Target Median Price': info.get('targetMedianPrice', 'N/A'),
        'Target High Price': info.get('targetHighPrice', 'N/A'),
        'Target Low Price': info.get('targetLowPrice', 'N/A'),
        'Current Price': info.get('currentPrice', 'N/A'),
    }

    df = pd.DataFrame([rating_data])
    return df


if __name__ == "__main__":
    # Test on NVDA
    ticker = "NVDA"

    # Method 1: Basic analyst ratings
    df1 = get_analyst_ratings(ticker)

    # Method 2: More detailed view
    print(f"\n{'='*60}")
    print("Detailed Analyst Ratings View:")
    print(f"{'='*60}")
    df2 = get_analyst_ratings_detailed(ticker)
    print(df2.to_string())

    # Display all columns (in case some are hidden)
    print(f"\n{'='*60}")
    print("All Available Columns:")
    print(f"{'='*60}")
    print(df2.columns.tolist())

    print(f"\n{'='*60}")
    print("DataFrame Info:")
    print(f"{'='*60}")
    df2.info()
