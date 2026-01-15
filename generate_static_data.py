from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import random

import yfinance as yf

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)


def calculate_rsi(ticker_obj, days=14):
    try:
        hist = ticker_obj.history(period=f"{days + 10}d")
        if hist.empty or len(hist) < days + 1:
            return 50.0
        deltas = hist["Close"].diff()
        gains = deltas.where(deltas > 0, 0)
        losses = -deltas.where(deltas < 0, 0)
        avg_gain = float(gains.rolling(window=days).mean().iloc[-1])
        avg_loss = float(losses.rolling(window=days).mean().iloc[-1])
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return round(100 - (100 / (1 + rs)), 2)
    except Exception:
        return 50.0


def generate_sample_data():
    tickers = [
        "NVDA",
        "GOOGL",
        "TSM",
        "AAPL",
        "AMD",
        "BMNR",
        "SOXX",
        "TSLA",
        "VOO",
        "JPM",
        "GE",
        "RTX",
        "SOFI",
        "HOOD",
        "GLD",
        "SLV",
        "UNH",
        "MAGS",
        "ITA",
        "PLTR",
        "MU",
        "XOM",
        "GS",
        "MS",
        "RKLB",
    ]

    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []

    print(f"Fetching real-time data for {len(tickers)} tickers...")

    for t in tickers:
        print(f"  > Processing {t}...")
        try:
            stock = yf.Ticker(t)
            info = stock.info

            qty = random.randint(50, 100)
            price = info.get("regularMarketPrice") or info.get("currentPrice") or 0.0
            change = info.get("regularMarketChangePercent") or 0.0
            rsi = calculate_rsi(stock)

            rows.append(
                {
                    "ticker": t,
                    "quantity": qty,
                    "current_price": round(price, 2),
                    "change_percent": round(change, 2),
                    "notional": round(qty * price, 2),
                    "bucket": random.choice(["Core Growth", "Tactical Opportunities", "High Volatility"]),
                    "rsi": rsi,
                    "weight_pct": 0,
                }
            )
        except Exception as e:
            print(f"    ! Error fetching {t}: {e}")
            # Fallback for failed tickers
            rows.append(
                {"ticker": t, "quantity": random.randint(50, 100), "current_price": 0.0, "change_percent": 0.0, "notional": 0.0, "bucket": "Unknown", "rsi": 50, "weight_pct": 0}
            )

    total_val = sum(r["notional"] for r in rows)
    for r in rows:
        if total_val > 0:
            r["weight_pct"] = round((r["notional"] / total_val) * 100, 2)

    dashboard = {"rows": rows, "generated_at": generated_at}

    eval_data = []
    for i, t in enumerate(tickers):
        eval_data.append(
            {
                "ticker": t,
                "rank": i + 1,
                "overall": round(random.uniform(6, 9.5), 1),
                "quality": round(random.uniform(6, 9.5), 1),
                "valuation": round(random.uniform(3, 8), 1),
                "moat": round(random.uniform(5, 9.8), 1),
                "upside": round(random.uniform(5, 20), 1),
                "bull": 0.7,
                "bear": 0.2,
            }
        )

    ui_data_dir = Path("ui/sample_data")
    ui_data_dir.mkdir(parents=True, exist_ok=True)
    (ui_data_dir / "dashboard.json").write_text(json.dumps(dashboard, indent=2))
    (ui_data_dir / "eval.json").write_text(json.dumps(eval_data, indent=2))

    print(f"\nSUCCESS: Sample data generated at {generated_at} with REAL API stats.")


if __name__ == "__main__":
    generate_sample_data()
