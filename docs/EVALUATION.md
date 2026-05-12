## Evaluation Framework v4 — Current Normal-CDF Scorecard

This framework turns messy investing judgments into a **consistent scorecard**: core fundamentals (moat/quality/valuation/upside/size) and **roles** (core/satellite/speculative/diversifier) that are assigned **after** scoring.

The current TypeScript implementation maps numeric stats through a **three-anchor Normal-CDF curve**. Anchors define the low, median, and high points for a metric; the median maps to a neutral `5.0`, and the curve saturates toward `0` or `10` near the outer anchors.

---

# 0) Data Source Policy For Scoring Stats

Stats-derived scores should prefer StockAnalysis / public web-source values for fundamental fields. Yahoo/yfinance is useful for market data and selected fallback fields, but it is not authoritative for sensitive fundamentals.

Observed Yahoo/yfinance caveats in this repo:

- Stock `PE` / `forward PE` can diverge from website-displayed values.
- Stock `revenueGrowth` and `earningsGrowth` can be definition/period mismatched for TTM-style comparisons.
- Yahoo `priceToSalesTrailing12Months` can be wrong for ADRs / foreign listings; TSM returned an unusable P/S value in this path.
- ETF `forward PE` may be stale or inaccurate.
- ETF holdings can be incomplete and may not match issuer holdings pages.
- Values may not consistently match Yahoo website views across all tickers/endpoints.

Policy implication:

- Treat Yahoo/yfinance as fallback only for sensitive valuation and holdings fields.
- Do not source `revenue_growth`, `debt_to_equity`, `ps`, or `ps_forward` from Yahoo/yfinance.
- Prefer StockAnalysis period-aligned values for `revenue_growth` and `eps_growth`.
- Use `ps_forward` only when an explicit Forward P/S or Forward Price/Sales ratio is displayed; otherwise keep it empty.
- Missing fundamental inputs should stay missing rather than poisoning scores with low-confidence fallback values.

---

# 1) What the framework produces

For each asset:

### A) Fundamental scores (0–10)

- **Moat**: replaceability under real constraints; currently blends stored/research output with a stats-derived economic moat signal when both exist
- **Quality**: durability of economics / execution
- **Valuation**: attractiveness of price relative to growth/quality
- **Upside**: growth-driven forward return setup, capped by weak business support
- **Size**: market-cap scale (robustness proxy)

### B) Ranking + roles

- **Overall score** = average of Moat, Quality, Valuation, and Upside, with missing components treated as neutral `5`
- If all score inputs are missing, Overall stays empty.
- **Role indices**: Core / Satellite / Speculative / Diversifier
- **Label** = argmax(role indices)

---

# 2) Anchors: the explicit definitions

Every mapped metric has **three anchors**:

- **Low**: notably good / cheap / strong (memorable best examples)
- **Median**: “good standard” (personal bar or S&P-ish median)
- **High**: notably stretched / weak (memorable worst examples)

Because the mapping is S-curved, the **median anchor dominates** how most names score; extremes mostly control saturation.

---

# 3) Mapping function: Normal-CDF curve from anchors

### 3.1 Normal-CDF score curve

The implementation uses an Abramowitz-Stegun approximation of the error function to compute a Normal-CDF-like percentile:

Score(x) = outMin + (outMax - outMin) * NormalCDF(curvePosition)

The median anchor maps to the midpoint between `outMin` and `outMax`. With default output bounds, that means:

- Low anchor -> `0`
- Median anchor -> `5`
- High anchor -> `10`

For lower-is-better metrics such as P/E, PEG, and debt/equity, the output bounds are inverted:

- Low anchor -> `10`
- Median anchor -> `5`
- High anchor -> `0`

### 3.2 Piecewise scale

The code uses the distance from low-to-median and median-to-high separately. Each side is divided by `3` to create the curve scale:

- If `x <= median`: `curveScale = (median - low) / 3`
- If `x > median`: `curveScale = (high - median) / 3`

Then:

curvePosition = (x - median) / curveScale

This makes the median neutral and the outer anchors near saturation.

### 3.3 Monotonic direction

Some metrics are “higher is better” (growth, upside). Others are “lower is better” (P/E, PEG).

The current code handles lower-is-better metrics by flipping the output bounds (`outMin = 10`, `outMax = 0`).

---

# 4) Score aggregation

Each available metric is mapped to a `0-10` factor score, multiplied by its configured multiplier, and averaged by total available multiplier weight:

MetricScore = clamp(mean(mappedFactorScore * multiplier), 0, 10)

Missing inputs are skipped. They do not count as zero, and they do not directly lower confidence in the output beyond reducing the evidence available to compute it.

Non-positive valuation multiples are not treated as cheap. They are mapped to the weak anchor for that component.

Quality has an explicit evidence gate: if fewer than two quality factors are available, the market-derived quality score is `null`.

The implementation also includes small viability floors:

- Quality can floor to `3`, `3.5`, or `4` when enough positive business signals exist.
- Valuation can floor to `2` when forward P/E, balance sheet, and FCF-yield checks indicate a viable business.

---

# 5) Full anchor list

These are the static fallback anchors in `src/stock-search/evaluation/constants.ts`.
At runtime, most stat anchors are loaded from the local calibration SQLite DB
when enough samples exist. Global positive metrics use p10 / p50 / p97, while
global inverse metrics use p3 / p50 / p90. Valuation scoring uses
sector-specific calibration anchors when the row has `sector_name` and the
sector has enough samples for that metric; sector valuation anchors use
p10 / p50 / p90 for both positive and inverse metrics. If a sector field is too
sparse, it falls back to the global dynamic anchor, then the static constants.

## 5.1 Size anchors (Market cap, USD)

- **Min**: $10B
- **Median**: $800B
- **Max**: **$4.5T** (NVDA cap ceiling anchor)

## 5.2 Valuation anchors

Valuation mixes lower-is-better multiples with higher-is-better yield and viability checks. Lower-is-better inputs use inverted output bounds.

- **PEG**: 0.6 / 2.0 / 5.0
- **P/E**: 10 / 30 / 85
- **Forward P/E**: 8 / 28 / 65
- **P/S**: 1 / 6 / 25
- **Forward P/S**: 1 / 5 / 22
- **Debt/equity ratio**: 0 / 0.8 / 3.0
- **FCF yield %**: -5 / 4 / 12
- **Shareholder yield %**: -5 / 3 / 10
- **Operating margin %**: -10 / 30 / 55
- **ROE %**: 0 / 25 / 80
- **ROIC %**: 0 / 25 / 80

## 5.3 Growth / quality anchors

“Higher is better”

- **Revenue growth (YoY %)**: -15 / 15 / 70
- **EPS growth %**: -30 / 15 / 100
- **Gross margin %**: 10 / 60 / 90
- **Operating margin %**: -10 / 30 / 55
- **ROE %**: 0 / 25 / 80
- **ROIC %**: 0 / 25 / 80
- **Shareholder yield %**: -5 / 3 / 10

## 5.4 Analyst target-gap anchor

“Higher is better”

- **Target upside %**: -25 / 15 / 60

## 5.5 Analyst rating anchor (1–5 scale)

“Higher is better”

- **Rating**: 1.0 / 3.5 / 5.0

# 6) Current anchor preset

| Metric          |  Low | Median (good) |      High |
| --------------- | ---: | ------------: | --------: |
| Market cap      | $10B |         $800B | **$4.5T** |
| PEG             |  0.6 |           2.0 |       5.0 |
| P/E             |   10 |            30 |        85 |
| Forward P/E     |    8 |            28 |        65 |
| P/S             |    1 |             6 |        25 |
| Forward P/S     |    1 |             5 |        22 |
| Revenue growth  |  -15 |            15 |        70 |
| EPS growth      |  -30 |            15 |       100 |
| Gross margin    |   10 |            60 |        90 |
| Operating margin |  -10 |            30 |        55 |
| Debt/equity ratio |  0 |           0.8 |       3.0 |
| FCF yield       |   -5 |             4 |        12 |
| Shareholder yield | -5 |             3 |        10 |
| ROE             |    0 |            25 |        80 |
| ROIC            |    0 |            25 |        80 |
| Target upside   |  -25 |            15 |        60 |
| Rating (1–5)    |  1.0 |    3.5 |       5.0 |

---

# 7) Score definitions

## 7.1 Moat (0–10)

“How hard is it to replace this under real constraints?”

Current implementation status: `moat_score` can be blended from stored/research
output plus market-derived economic moat stats. The research/LLM side is still
a placeholder until real research generation is wired, but the deterministic
stats side is active.

- switching costs, integration depth, ecosystem lock-in
- regulatory/security/procurement barriers
- data/feedback loops (when not easily replicated)
- physics bottlenecks / supply chain choke points

Market-derived moat uses these contribution multipliers:

- revenue scale 1.00
- FCF scale 0.75
- gross margin 1.50
- operating margin 1.50
- ROE 0.50
- ROIC 1.50
- debt/equity 0.50

### Commodities: moat is scarcity + role (not competition)

CommodityMoat can be defined as:

Moat_commodity = 0.30·Scarcity + 0.30·MonetaryRole + 0.25·(10−Substitutability) + 0.15·(10−SupplyElasticity)

This yields sensible ordering like gold > silver on “role,” while still acknowledging industrial demand effects.

## 7.2 Quality (0–10)

“How reliably does the asset/business generate durable economics across regimes?”

- cash conversion, margins, resilience
- balance sheet strength
- execution reliability (delivery, safety, compliance where relevant)

Quality should not be reduced to a single growth or gross-margin number. Keep the first-pass stats understandable: gross margin says whether the product economics are attractive, while operating margin says whether the core business still works after normal company operating costs. Net/profit margin can stay behind the scenes because taxes, interest, accounting marks, and one-time items can make it noisy.

- **Revenue growth**: whether the business is expanding.
- **EPS growth**: whether growth is reaching per-share earnings.
- **Gross margin**: whether the product/service has attractive unit economics.
- **Operating margin**: whether gross profit survives normal operating expenses.
- **ROE**: whether common equity produces returns; useful as a companion to ROIC, but more leverage-sensitive.
- **ROIC**: whether capital is actually producing returns.
- **Shareholder yield / dilution**: whether per-share owners are being rewarded or diluted.

Interpretation rules:

- High gross margin should not rescue deeply negative operating margin.
- Growth should be discounted when it is bought with heavy dilution.
- If fewer than two comparable quality stats are available, the market-derived quality signal should stay unknown rather than letting one stat produce a false high-confidence score.
- Interest coverage and Piotroski F-Score are not part of the current scoring implementation.

## 7.3 Valuation (0–10) — weighted mapped blend

Valuation is not a single metric. It is a blend of mapped stat contributions:

- PEG score
- trailing P/E score
- forward P/E score
- debt/equity score
- FCF yield score when market cap and free cash flow are available
- shareholder yield score when dividends, buybacks, and dilution are available
- operating margin score as a valuation viability check
- ROIC score as a valuation viability check
- size score as a market validation / scale support check
- revenue scale score as operating scale support
- EPS growth score as per-share earnings growth support

Valuation anchors are sector-relative when possible. This keeps a bank, utility,
semiconductor, and internet platform from being judged against one universal
multiple distribution. If a sector field has too few samples, that field uses
the global calibration anchor instead.

Implemented multipliers use `1.0` as full strength and `0.5` as support strength. Valuation is mostly price-paid inputs, with profitability, balance sheet, and shareholder returns included as support so expensive multiples backed by better economics are not treated the same as unsupported expensive multiples.

- PEG 2.00
- trailing P/E 1.00
- forward P/E 1.50
- FCF yield 1.00
- shareholder yield 0.50
- EPS growth 0.50
- debt/equity 0.50
- operating margin 0.50
- ROIC 0.50
- size 1.00
- revenue scale 0.50

Market-derived quality uses these contribution multipliers:

- revenue scale 1.00
- revenue growth 1.20
- EPS growth 1.00
- gross margin 1.00
- operating margin 1.00
- ROE 1.00
- ROIC 1.00
- FCF scale 1.00
- shareholder yield 0.50

Revenue scale uses directly extracted trailing revenue. FCF scale uses absolute free cash flow. FCF yield remains a valuation component because it measures cash generation relative to price paid.

If some inputs are missing, the mean is taken over the available components only. Missing data should reduce confidence, not automatically count as a zero contribution. Non-positive P/E or PEG values are not cheap; they represent loss-making or non-meaningful multiples and should map to the weak side of that component.

EV/Sales, earnings growth, interest coverage, and Piotroski F-Score are not currently part of the score engine.

## 7.4 Upside (0–10) — growth-centered return setup

Upside is intentionally narrower than Overall. It measures growth-driven
forward return potential and analyst setup, then applies Valuation, Quality,
and Moat as trust gates. Those support scores are not raw upside inputs; they
only cap weak setups so low-quality hype does not get the same upside treatment
as durable growth.

Raw upside requires at least two available raw inputs:

- revenue growth score, weight 1.00
- EPS growth score, weight 1.00
- analyst target-gap score (`median_upside`), weight 0.75
- analyst rating score, weight 0.50

RawUpside = weighted average of the available raw inputs.

Support gates:

- If valuation score is below `3`, cap Upside at `6`.
- If quality score is below `3`, cap Upside at `6`.
- If moat score is below `3`, cap Upside at `6`.
- If valuation score is below `2` and quality score is below `3`, cap Upside at
  `4`.

Upside = clamp(`RawUpside` after support caps, 0, 10).

The displayed stats-derived upside score does not use LLM outlook. Stored or
future LLM outlook can still exist as research context, but it is not part of
this deterministic score.

## 7.5 Size (0–10)

Size maps market cap on a log-like perception scale (because $4T is not “4×” $1T in practical robustness). Anchors define the saturation behavior.

---

# 8) Overall ranking metric

Overall = average(Moat, Quality, Valuation, Upside), with missing components contributing neutral `5`

Size is intentionally excluded from Overall to avoid mixing “intrinsic strength” with “scale”.

Stats improve the four underlying scores rather than becoming a separate top-rank penalty system. If a name has extreme upside but poor ROIC, operating margin, dilution, or free-cash-flow yield, those facts should lower Quality and/or Valuation directly. The role system can still label it speculative, but the raw fundamental inputs should already reflect the weaker evidence.

---

# 9) Labels come after scores (role indices)

Roles are not opinions. They are derived mechanically from scores.

Compute indices:

### Core index (durability + scale + reasonable price)

CoreIndex = 0.30·Moat + 0.30·Quality + 0.10·Valuation + 0.30·Size

### Satellite index (theme + upside, still quality-aware)

SatelliteIndex = 0.25·Moat + 0.25·Quality + 0.25·Valuation + 0.25·Upside

### Speculative index (convexity + fragility)

SpecIndex = 0.50·Upside + 0.20·(10−Quality) + 0.20·(10−Moat) + 0.10·(10−Valuation)

### Diversifier index (stability / hedge behavior)

DivIndex = 0.40·Quality + 0.30·Valuation + 0.20·Size + 0.10·(10−Upside)

### Label rule

Label = argmax(CoreIndex, SatelliteIndex, SpecIndex, DivIndex)

(If desired, additional “gates” can be layered later, but the core philosophy is score → index → label.)

---

## Practical anchor philosophy

Anchors are not “statistics.” Anchors are **definitions**:

- the median is the current neutral center of the implemented curve
- extremes are what “notable” means
- the Normal-CDF mapping ensures robustness and saturation with a simple curve

That makes the framework stable, interpretable, and anchored to explicit definitions instead of over-precise directional odds.

---

# 10) Implementation notes

This document follows the current TypeScript implementation.

## Current behavior

- Overall is computed across Moat, Quality, Valuation, and Upside; missing components contribute neutral `5` so incomplete rows do not get inflated by a high two-factor average.
- Size is excluded from Overall.
- Role indices are computed after scoring from Core / Satellite / Speculative / Diversifier formulas.
- Dashboard normalization recomputes deterministic moat, quality, valuation, upside, and size from current stats when possible.
- Stored LLM quality is retained as `llm_quality_score` only. Displayed `quality_score` is market-stat-derived when enough quality stats exist.
- Stored/default valuation, upside, market-cap score, and overall values are not used as dashboard fallbacks when current stats cannot derive them.
- Moat blends stored/research output with a deterministic stats-derived economic moat signal when both are available.
- Upside is deterministic: raw revenue growth, EPS growth, analyst target gap, and analyst rating are blended first, then valuation/quality/moat support applies only as caps. It does not use LLM outlook for the displayed stats-derived score.
- Dashboard rank currently sorts by `overall_score`; role indices label the asset but do not drive table rank.
- Rows without stored evaluation and without enough derived stats now keep evaluation fields empty rather than inventing default fallback scores.
