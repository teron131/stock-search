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

- **Moat**: replaceability under real constraints; currently stored/research-driven and treated as a placeholder in stats-only scoring work
- **Quality**: durability of economics / execution
- **Valuation**: attractiveness of price relative to growth/quality
- **Upside**: payoff size if the thesis plays out
- **Size**: market-cap scale (robustness proxy)

### B) Ranking + roles

- **Overall score** = average of (Moat, Quality, Valuation, Upside)
- Dashboard Overall is only recomputed when all four inputs are available after deterministic stat refresh.
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

These are the current code anchors in `src/stock-search/evaluation/constants.ts`.

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
- **ROIC %**: 0 / 25 / 80

## 5.3 Growth / quality anchors

“Higher is better”

- **Revenue growth (YoY %)**: -15 / 15 / 70
- **Gross margin %**: 10 / 60 / 90
- **Operating margin %**: -10 / 30 / 55
- **ROIC %**: 0 / 25 / 80
- **Shareholder yield %**: -5 / 3 / 10

## 5.4 Upside anchor (Analyst target upside)

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
| Gross margin    |   10 |            60 |        90 |
| Operating margin |  -10 |            30 |        55 |
| Debt/equity ratio |  0 |           0.8 |       3.0 |
| FCF yield       |   -5 |             4 |        12 |
| Shareholder yield | -5 |             3 |        10 |
| ROIC            |    0 |            25 |        80 |
| Target upside   |  -25 |            15 |        60 |
| Rating (1–5)    |  1.0 |    3.5 |       5.0 |

---

# 7) Score definitions

## 7.1 Moat (0–10)

“How hard is it to replace this under real constraints?”

Current implementation status: `moat_score` comes from stored evaluation / research output. It is not computed from market stats yet, so it should be treated as a placeholder when iterating on stats-derived scores.

- switching costs, integration depth, ecosystem lock-in
- regulatory/security/procurement barriers
- data/feedback loops (when not easily replicated)
- physics bottlenecks / supply chain choke points

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
- **Gross margin**: whether the product/service has attractive unit economics.
- **Operating margin**: whether gross profit survives normal operating expenses.
- **ROIC**: whether capital is actually producing returns.
- **P/S**: revenue scale proxy relative to market value; lower P/S means more revenue per market-cap dollar.
- **Shareholder yield / dilution**: whether per-share owners are being rewarded or diluted.

Interpretation rules:

- High gross margin should not rescue deeply negative operating margin.
- Growth should be discounted when it is bought with heavy dilution.
- If fewer than two comparable quality stats are available, the market-derived quality signal should stay unknown rather than letting one stat produce a false high-confidence score.
- Interest coverage and Piotroski F-Score are not part of the current scoring implementation.

## 7.3 Valuation (0–10) — weighted mapped blend

Valuation is not a single metric. It is a blend of mapped stat contributions:

- PEG score (largest weight)
- trailing P/E score
- forward P/E score
- P/S score
- forward P/S score
- debt/equity score
- FCF yield score when market cap and free cash flow are available
- shareholder yield score when dividends, buybacks, and dilution are available
- operating margin score as a valuation viability check
- ROIC score as a valuation viability check

Implemented multipliers use `1.0` as normal strength. Valuation is mostly price-paid inputs, with profitability and returns included as lighter support so expensive multiples backed by better economics are not treated the same as unsupported expensive multiples.

- PEG 1.60
- trailing P/E 1.00
- forward P/E 1.00
- P/S 0.90
- forward P/S 0.70
- FCF yield 1.00
- shareholder yield 0.40
- debt/equity 0.40
- operating margin 0.60
- ROIC 0.40

Market-derived quality uses these contribution multipliers:

- revenue growth 1.20
- gross margin 1.00
- operating margin 1.00
- ROIC 0.90
- P/S 0.40
- shareholder yield 0.30

If some inputs are missing, the mean is taken over the available components only. Missing data should reduce confidence, not automatically count as a zero contribution. Non-positive P/E, PEG, or P/S values are not cheap; they represent loss-making or non-meaningful multiples and should map to the weak side of that component.

EV/Sales, earnings growth, interest coverage, and Piotroski F-Score are not currently part of the score engine.

## 7.4 Upside (0–10) — three-channel blend

Upside merges:

1. **Analyst target upside** (mapped via upside anchors), weight 1.40
2. **Analyst consensus rating** (mapped via rating anchors), weight 0.60
3. **Forward outlook score** (structured subjective/LLM score on 0–10; placeholder in stats-only dashboard normalization), weight 1.00

The full evaluation path averages available channels by weight. Dashboard normalization uses only analyst target upside and ratings, so it does not let LLM outlook change the displayed stats-derived upside score.

## 7.5 Size (0–10)

Size maps market cap on a log-like perception scale (because $4T is not “4×” $1T in practical robustness). Anchors define the saturation behavior.

---

# 8) Overall ranking metric

Overall = (Moat + Quality + Valuation + Upside) / 4

Size is intentionally excluded from Overall to avoid mixing “intrinsic strength” with “scale”.

Stats improve the four underlying scores rather than becoming a separate top-rank penalty system. If a name has extreme upside but poor ROIC, operating margin, dilution, or free-cash-flow yield, those facts should lower Quality and/or Valuation directly. The role system can still label it speculative, but the raw fundamental inputs should already reflect the weaker evidence.

---

# 9) Labels come after scores (role indices)

Roles are not opinions. They are derived mechanically from scores.

Compute indices:

### Core index (durability + scale + reasonable price)

CoreIndex = 0.35·Moat + 0.35·Quality + 0.10·Valuation + 0.20·Size

### Satellite index (theme + upside, still quality-aware)

SatelliteIndex = 0.30·Moat + 0.25·Quality + 0.20·Valuation + 0.25·Upside

### Speculative index (convexity + fragility)

SpecIndex = 0.45·Upside + 0.20·(10−Quality) + 0.20·(10−Moat) + 0.15·(10−Valuation)

### Diversifier index (stability / hedge behavior)

DivIndex = 0.45·Quality + 0.25·Valuation + 0.20·Size + 0.10·(10−Upside)

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

- Overall is computed as the average of Moat, Quality, Valuation, and Upside.
- Size is excluded from Overall.
- Role indices are computed after scoring from Core / Satellite / Speculative / Diversifier formulas.
- Dashboard normalization recomputes deterministic quality, valuation, upside, and size from current stats when possible.
- Stored LLM quality is retained as `llm_quality_score` only. Displayed `quality_score` is market-stat-derived when enough quality stats exist.
- Stored/default valuation, upside, market-cap score, and overall values are not used as dashboard fallbacks when current stats cannot derive them.
- Moat remains research/stored-evaluation driven and should be treated as a placeholder for stats-only scoring. There is no stats-derived moat engine yet.
- Upside blends analyst target upside, analyst rating, and forward outlook in the full evaluation path. Dashboard normalization uses analyst target upside and ratings, with no LLM outlook score.
- Dashboard rank currently sorts by `overall_score`; role indices label the asset but do not drive table rank.
- Rows without stored evaluation and without enough derived stats now keep evaluation fields empty rather than inventing default fallback scores.
