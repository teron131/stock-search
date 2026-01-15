from datetime import UTC, datetime
import json
import random


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

    # We will put the "generated time" in the dashboard metadata or just a separate field
    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    rows = []
    for t in tickers:
        qty = random.randint(50, 100)
        # Random but plausible prices
        price = random.uniform(10, 600)
        change = random.uniform(-5, 5)
        rows.append(
            {
                "ticker": t,
                "quantity": qty,
                "current_price": round(price, 2),
                "change_percent": round(change, 2),
                "notional": round(qty * price, 2),
                "bucket": random.choice(["Core Growth", "Tactical Opportunities", "High Volatility"]),
                "rsi": random.randint(30, 70),
                "weight_pct": 0,  # Will be calculated by UI or here
            }
        )

    # Calculate weights
    total_val = sum(r["notional"] for r in rows)
    for r in rows:
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

    # Save to ui folder for static hosting
    ui_data_dir = Path("ui/sample_data")
    ui_data_dir.mkdir(parents=True, exist_ok=True)

    (ui_data_dir / "dashboard.json").write_text(json.dumps(dashboard, indent=2))
    (ui_data_dir / "eval.json").write_text(json.dumps(eval_data, indent=2))

    print(f"Sample data generated at {generated_at}")


if __name__ == "__main__":
    from pathlib import Path

    generate_sample_data()
