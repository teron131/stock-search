#!/usr/bin/env python3
"""Portfolio notional analysis script - calculate and display portfolio metrics."""

import pandas as pd
from stock_search.schema import PortfolioPosition, Portfolio
from stock_search.portfolio import calculate_notional, calculate_position_weight


def analyze_portfolio(portfolio: Portfolio) -> pd.DataFrame:
    """
    Analyze portfolio and return results as DataFrame.

    Calculates notional exposure and weight for each position.

    Args:
        portfolio: Portfolio object with positions and total_equity

    Returns:
        DataFrame with columns: Ticker, Quantity, Delta, Price, Notional, Weight%, Bucket
    """
    rows = []

    for position in portfolio.positions:
        notional = calculate_notional(
            position.quantity, position.delta, position.current_price
        )
        weight = calculate_position_weight(notional, portfolio.total_equity)

        rows.append(
            {
                "Ticker": position.ticker,
                "Quantity": position.quantity,
                "Delta": position.delta,
                "Price": position.current_price,
                "Notional": notional,
                "Weight %": weight,
                "Bucket": position.bucket,
            }
        )

    df = pd.DataFrame(rows)

    # Add totals row
    total_notional = df["Notional"].sum()
    total_weight = df["Weight %"].sum()
    totals = {
        "Ticker": "TOTAL",
        "Quantity": "",
        "Delta": "",
        "Price": "",
        "Notional": total_notional,
        "Weight %": total_weight,
        "Bucket": "",
    }
    df = pd.concat([df, pd.DataFrame([totals])], ignore_index=True)

    # Format currency columns
    df["Price"] = df["Price"].apply(lambda x: f"${x:,.2f}" if isinstance(x, float) else x)
    df["Notional"] = df["Notional"].apply(
        lambda x: f"${x:,.2f}" if isinstance(x, float) else x
    )
    df["Weight %"] = df["Weight %"].apply(
        lambda x: f"{x:.2f}%" if isinstance(x, float) else x
    )

    return df


def portfolio_summary(portfolio: Portfolio) -> dict:
    """
    Get portfolio summary statistics.

    Args:
        portfolio: Portfolio object

    Returns:
        Dict with summary metrics
    """
    total_notional = sum(
        calculate_notional(p.quantity, p.delta, p.current_price)
        for p in portfolio.positions
    )
    effective_leverage = total_notional / portfolio.total_equity

    buckets = {}
    for position in portfolio.positions:
        notional = calculate_notional(
            position.quantity, position.delta, position.current_price
        )
        if position.bucket not in buckets:
            buckets[position.bucket] = 0
        buckets[position.bucket] += notional

    return {
        "total_equity": portfolio.total_equity,
        "total_notional": total_notional,
        "effective_leverage": effective_leverage,
        "notional_by_bucket": buckets,
    }


if __name__ == "__main__":
    # Example portfolio
    positions = [
        PortfolioPosition(
            ticker="NVDA",
            quantity=100,
            delta=1.0,
            current_price=184.97,
            bucket="core_engine",
        ),
        PortfolioPosition(
            ticker="GOOG",
            quantity=10,
            delta=0.75,
            current_price=155.30,
            bucket="core_engine",
        ),
        PortfolioPosition(
            ticker="TSLA",
            quantity=50,
            delta=1.0,
            current_price=285.00,
            bucket="core_satellite",
        ),
        PortfolioPosition(
            ticker="GLD",
            quantity=100,
            delta=1.0,
            current_price=181.00,
            bucket="defensive",
        ),
    ]

    portfolio = Portfolio(total_equity=50000, positions=positions)

    # Analyze portfolio
    print("=" * 100)
    print("PORTFOLIO ANALYSIS")
    print("=" * 100)
    df = analyze_portfolio(portfolio)
    print(df.to_string(index=False))

    # Summary
    print("\n" + "=" * 100)
    print("SUMMARY")
    print("=" * 100)
    summary = portfolio_summary(portfolio)
    print(f"Total Equity: ${summary['total_equity']:,.2f}")
    print(f"Total Notional Exposure: ${summary['total_notional']:,.2f}")
    print(f"Effective Leverage: {summary['effective_leverage']:.2f}x")

    print("\nNotional by Bucket:")
    for bucket, notional in summary["notional_by_bucket"].items():
        weight = (notional / summary["total_notional"]) * 100
        print(f"  {bucket:20s}: ${notional:>12,.2f}  ({weight:>6.2f}%)")
