## Evaluation Framework v5 — Current Deterministic Scorecard

This framework turns messy investing judgments into a **consistent scorecard**: core fundamentals (moat/quality/valuation/upside/size) and **roles** (core/satellite/speculative/diversifier) that are assigned **after** scoring.

The current TypeScript implementation maps numeric stats through a **three-anchor Normal-CDF curve**. Anchors define the low, median, and high points for a metric; the median maps to a neutral `5.0`, and the curve saturates toward `0` or `10` near the outer anchors.

The current displayed scores are deterministic. LLM-driven research scores can
be present, absent, or explicitly `null`; they are accepted by the schema, but
they remain placeholders and are not required for dashboard scoring.

---

# 0. Data Source Policy For Scoring Stats

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
- ETFs with holdings-proxy stats are scored as weighted baskets of their
  underlying stock rows. Raw ETF wrapper-level fundamentals are not used as a
  stock-like substitute when the proxy fields are absent.

---

# 1. What the framework produces

For each asset:

### A. Fundamental scores (0–10)

- **Moat**: replaceability under real constraints; currently blends stored/research output with a stats-derived economic moat signal when both exist
- **Quality**: durability of economics / execution
- **Valuation**: attractiveness of price relative to growth/quality
- **Upside**: growth-driven forward return setup, capped by weak business support
- **Size**: market-cap scale (robustness proxy)
- **Tactical**: short-to-medium-term setup, separate from durable fundamentals

### B. Ranking + roles

- **Overall score** = weighted blend of Moat, Quality, Valuation, and Upside, with missing components treated as neutral `5`
- If all score inputs are missing, Overall stays empty.
- **Role indices**: Core / Satellite / Speculative / Diversifier
- **Label** = gated role label derived from absolute score thresholds; role indices remain available as diagnostics

---

# 2. Anchors: the explicit definitions

Every mapped metric has **three anchors**:

- **Low**: notably good / cheap / strong (memorable best examples)
- **Median**: “good standard” (personal bar or S&P-ish median)
- **High**: notably stretched / weak (memorable worst examples)

Because the mapping is S-curved, the **median anchor dominates** how most names score; extremes mostly control saturation.

---

# 3. Mapping function: Normal-CDF curve from anchors

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

# 4. Score aggregation

Each available metric is mapped to a `0-10` factor score, multiplied by its configured multiplier, and averaged by total available multiplier weight:

MetricScore = clamp(mean(mappedFactorScore * multiplier), 0, 10)

Missing inputs are skipped. They do not count as zero, and they do not directly lower confidence in the output beyond reducing the evidence available to compute it.

Non-positive valuation multiples are not treated as cheap. They are mapped to the weak anchor for that component.

Quality has an explicit evidence gate: if fewer than two quality factors are available, the market-derived quality score is `null`.

Single-year growth is capped inside durable scores so a peak growth year cannot
create a perfect durability or valuation signal by itself:

- Revenue growth and EPS growth contributions to Quality are capped at `8.5`.
- EPS growth support inside Valuation is capped at `7.0`.

The implementation includes peak-cycle risk detection. It emphasizes
growth-spike-vs-trend, margin-spike-vs-trend, cheap multiples after earnings
spikes, one-year price momentum, RSI, and implied volatility. High current
growth is not cycle risk by itself when the 3Y trend also supports it.

The implementation also includes small viability floors:

- Quality can floor to `3`, `3.5`, or `4` when enough positive business signals exist.
- Valuation can floor to `2` when forward P/E, balance sheet, and FCF-yield checks indicate a viable business.
- Supported high-moat/high-quality rows can floor valuation to `4` or `4.5`.

Shared risk adjustments:

- `overheatRisk` uses revenue growth, EPS growth, 1Y price change, RSI, and IV.
- Each overheat signal ramps from start to full risk:
  - revenue growth: `50 -> 120`
  - EPS growth: `100 -> 350`
  - 1Y price change: `150 -> 500`
  - RSI: `75 -> 90`
  - IV: `70 -> 100`
- Overheat risk is ignored unless at least `2` signals are active.
- Quality subtracts `overheatRisk * 0.75`.
- Valuation scores above neutral are pulled toward `5` by
  `(score - 5) * overheatRisk * 0.30`.
- Upside subtracts `overheatRisk * 1.25`.

---

# 5. Full anchor list

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

P/S and Forward P/S anchors are still maintained in the calibration layer, but they are not active inputs in the current Valuation score.

## 5.3 Growth / quality anchors

“Higher is better”

- **Revenue growth (YoY %)**: -15 / 15 / 70
- **EPS growth %**: -30 / 15 / 100
- **Gross margin %**: 10 / 60 / 90
- **Operating margin %**: -10 / 30 / 55
- **ROE %**: 0 / 25 / 80
- **ROIC %**: 0 / 25 / 80
- **Shareholder yield %**: -5 / 3 / 10
- **R&D knowledge capital**: $0.5B / $3B / $10B
- **R&D intensity %**: 2 / 10 / 18

## 5.4 Analyst target-gap anchor

“Higher is better”

- **Target upside %**: -25 / 15 / 60

## 5.5 Analyst rating anchor (1–5 scale)

“Higher is better”

- **Rating**: 1.0 / 3.5 / 5.0

# 6. Current anchor preset

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
| R&D knowledge capital | $0.5B | $3B | $10B |
| R&D intensity | 2 | 10 | 18 |
| ROE             |    0 |            25 |        80 |
| ROIC            |    0 |            25 |        80 |
| Target upside   |  -25 |            15 |        60 |
| Rating (1–5)    |  1.0 |    3.5 |       5.0 |

---

# 7. Score definitions

## 7.1 Moat (0–10)

“How hard is it to replace this under real constraints?”

Current implementation status: dashboard scoring recomputes deterministic
stats-derived moat from current indicators. Stored research/LLM fields can
exist as placeholders, but they are not required for the displayed score.

- switching costs, integration depth, ecosystem lock-in
- regulatory/security/procurement barriers
- data/feedback loops (when not easily replicated)
- physics bottlenecks / supply chain choke points

Market-derived moat uses these contribution multipliers:

- revenue scale 0.75
- FCF scale 0.75
- current gross margin 0.75
- current operating margin 0.75
- ROE 0.30
- ROIC 0.75
- debt/equity 0.30

The deterministic moat score now blends economic proof (`45%`) with structural
proxy evidence (`55%`). The structural proxy uses:

- `rd_knowledge_capital` 0.50
- R&D productivity 0.75
- 3Y margin persistence 1.50
- ROIC persistence 1.25
- scale persistence 1.00
- capital productivity 0.75

Structural proxy formula:

```ts
structuralMoatProxy = weightedMeanScore([
  [knowledgeCapitalScore, 0.50],
  [rdProductivityScore, 0.75],
  [marginPersistenceScore, 1.50],
  [roicPersistenceScore, 1.25],
  [scalePersistenceScore, 1.00],
  [capitalProductivityScore, 0.75],
]);

moat = weightedMeanScore([
  [economicMoatScore, 0.45],
  [structuralMoatProxy, 0.55],
]);
```

R&D signals are productively gated: R&D scale and intensity can only help moat
when persistent margins and ROIC also support the claim. If margin persistence
or ROIC is weak, the R&D contribution is capped at `4`. This is meant to lift
ASML-like bottleneck businesses without rescuing cash-burning R&D spend.
Raw R&D scale is used only when the StockAnalysis financials currency is
reasonably comparable (`USD`, `EUR`, `GBP`, `CHF`, `CAD`, `AUD`); otherwise
the model still uses currency-safe R&D intensity and margin persistence.

R&D productivity blends comparable-currency knowledge capital (`65%`) with R&D
intensity (`35%`). Margin persistence uses:

```ts
marginPersistenceScore = weightedMeanScore([
  [grossMarginMedian3y ?? currentGrossMargin, 0.25],      // 20 / 45 / 70
  [operatingMarginMedian3y ?? currentOperatingMargin, 0.35], // 5 / 25 / 45
  [fcfMarginMedian3y, 0.25],                              // -5 / 15 / 35
  [operatingMarginStd3y inverse score, 0.15],             // 0 / 12 / 35
]);

scalePersistenceScore = weightedMeanScore([
  [revenueScaleScore, 0.30],
  [fcfScaleScore, 0.25],
  [revenueCagr3yScore, 0.25],
  [marginPersistenceScore, 0.20],
]);

capitalProductivityScore = min(
  weightedMeanScore([fcfMarginMedian3yScore, roicScore, marginPersistenceScore]),
  marginPersistenceScore + 1,
  roicScore + 1,
);
```

High-cycle caps:

- if `cycleRisk >= 0.65`, Moat is capped at `7.5`.
- if no trend history exists and `cycleRisk >= 0.25`, Moat is capped at `8.2`.

Commodity and asset-proxy-specific moat engines are not currently implemented.
Bank-like rows skip normal debt/equity and FCF-yield penalties until bank
metrics exist.

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
- Revenue growth and EPS growth are useful signals, but each is capped at `8.5`
  inside Quality so one unusually strong year does not become a perfect durable
  quality score.
- Generic overheat/cycle risk can reduce the final Quality score.
- Interest coverage and Piotroski F-Score are not part of the current scoring implementation.

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

The raw quality score is then blended with persistence and owner-discipline
signals:

```ts
quality = weightedMeanScore([
  [currentQualityScore, 0.55],
  [marginPersistenceScore, 0.20],
  [fcfMarginMedian3yScore, 0.10],
  [sharesChangeDisciplineScore, 0.10],
  [stabilityScore, 0.05],
]);
```

High-cycle rows can still receive a current-profitability floor when the
current quality signal and margin persistence are both adequate:

```ts
if (cycleRisk >= 0.65 && currentQualityScore >= 7 && marginPersistenceScore >= 5) {
  quality = Math.max(quality, 5.0);
}
```

Quality floors require at least `3` positive business signals among:

- revenue growth > `0`
- EPS growth > `0`
- operating margin > `0`
- ROE > `0`
- ROIC > `0`
- gross margin > `0`
- FCF yield > `0`

Then:

- ROIC >= `25` and operating margin > `0` floors Quality at `4.0`.
- Revenue growth >= `15` and operating margin > `0` floors Quality at `3.5`.
- Otherwise the viable-business floor is `3.0`.

If `cycleRisk >= 0.65`, Quality is capped at `7.3`.

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

- PEG 1.50
- trailing P/E 1.00
- forward P/E 1.50
- FCF yield 1.00
- shareholder yield 0.50
- EPS growth 0.25
- debt/equity 0.50
- operating margin 0.50
- ROIC 0.50
- size 0.50
- revenue scale 0.40

Revenue scale uses directly extracted trailing revenue. FCF scale uses absolute free cash flow. FCF yield remains a valuation component because it measures cash generation relative to price paid.

If some inputs are missing, the mean is taken over the available components only. Missing data should reduce confidence, not automatically count as a zero contribution. Non-positive P/E or PEG values are not cheap; they represent loss-making or non-meaningful multiples and should map to the weak side of that component.

Direct EPS-growth support is capped at `7.0` inside Valuation so a peak-cycle
earnings spike does not make a business look structurally cheap on its own.
Generic overheat/cycle risk pulls high valuation scores toward neutral instead
of treating overheated momentum as durable cheapness.

FCF yield is blended between current FCF yield and normalized FCF yield:

```ts
normalizedFcf = revenue * (fcf_margin_median_3y / 100);
normalizedFcfYield = normalizedFcf / marketCap * 100;

fcfYieldScore = weightedMeanScore([
  [currentFcfYieldScore, 0.60],
  [normalizedFcfYieldScore, 0.40],
]);
```

Bank-like rows skip normal debt/equity and FCF-yield valuation penalties until
bank-specific metrics are available.

Cycle-sensitive cheapness is capped when valuation is very high and the setup
also looks tactically hot:

```ts
if (valuation > 7.5 && tacticalSetup > 8 && cycleRisk >= 0.45) {
  valuation = Math.min(valuation, 7.2);
}

if (valuation > 8.5 && tacticalSetup > 8.5) {
  valuation = Math.min(valuation, 7.8);
}
```

High-moat/high-quality valuation floors can lift supported compounders to
`4.0` or `4.5`, but only when free cash flow, operating margin, and ROIC are
all positive. This avoids rescuing broken rows with negative cash generation or
returns.

Exact valuation floors:

- Viable-business floor `2.0` requires positive forward P/E no worse than the
  weak forward-P/E anchor, debt/equity missing or no worse than the median
  anchor, and positive FCF yield.
- Strong quality-backed floor `4.0` requires Moat >= `7`, Quality >= `7`,
  positive free cash flow, positive operating margin, and positive ROIC.
- Elite quality-backed floor `4.5` uses the same profitability gate and
  requires Moat >= `8`, Quality >= `8`.

Warranted FPE is skipped when forward P/E is missing/non-positive or the row
has broken profitability: operating margin <= `0`, ROIC <= `0`, and FCF yield
<= `0`.

Final Valuation is:

```ts
valuation = weightedMeanScore([
  [legacyValuationScore, 0.55],
  [warrantedFpeScore, 0.45],
]);
```

If `cycleRisk >= 0.65`, Valuation is capped at `6.8`.

EV/Sales, interest coverage, and Piotroski F-Score are not currently part of the score engine.

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

Analyst ratings are normalized before scoring:

- Strong Buy -> `5.0`
- Buy -> `4.5`
- Overweight / Outperform -> `4.0`
- Hold / Neutral -> `3.5`
- Underperform / Underweight -> `2.5`
- Sell -> `1.0`

Support gates:

- If valuation score is below `3`, cap Upside at `6`.
- If valuation score is below `3.5`, cap very high Upside at `7.5`.
- If quality score is below `3`, cap Upside at `6`.
- If moat score is below `3`, cap Upside at `6`.
- If valuation score is below `2` and quality score is below `3`, cap Upside at
  `4`.
- If analyst target gap is negative, cap Upside at `6`.
- If analyst target gap is `-25%` or worse, cap Upside at `4.5`.
- If Tactical < `4`, revenue growth < `8`, and raw Upside < `7`, cap Upside at
  `5.5`.
- Generic overheat/cycle risk reduces Upside after support caps.
- If `cycleRisk >= 0.65`, Upside is capped at `7.0`.

Upside = clamp(`RawUpside` after support caps, 0, 10).

The displayed stats-derived upside score does not use LLM outlook. Stored or
future LLM outlook can still exist as research context, but it is not part of
this deterministic score.

## 7.5 Size (0–10)

Size maps market cap on a log-like perception scale (because $4T is not “4×” $1T in practical robustness). Anchors define the saturation behavior.

## 7.6 Tactical (0–10)

Tactical is a separate short-to-medium-term setup score. It is included in
portfolio rows as `tactical_score`, but it does not feed Overall.

Current tactical inputs:

- one-year price momentum, weight 1.25
- six-month price momentum, weight 0.75
- revenue growth, weight 1.00
- EPS growth, weight 1.00
- Valuation score, weight 0.75
- analyst target gap, weight 0.50
- RSI activity, weight 0.25
- implied-volatility activity, weight 0.25

Tactical mapping curves:

- 1Y / 6M price momentum: `-50 / 50 / 250`
- RSI activity: `30 / 55 / 85`
- IV activity: `20 / 45 / 90`
- Revenue and EPS growth reuse the normal growth anchors.

The current Tactical score does not include estimate revisions, backlog,
product-cycle position, HBM exposure, AI capex exposure, supply/demand
tightness, or LLM/research context.

---

# 8. Overall ranking metric

Overall is bottleneck-aware:

OverallRaw = 0.35·Moat + 0.30·Quality + 0.20·Valuation + 0.15·Upside

Missing components contribute neutral `5`. If all four inputs are missing,
Overall stays `null`.

BottleneckPenalty = max(0, 5 − min(Moat, Quality, Valuation)) × 0.25

Overall = clamp(OverallRaw − BottleneckPenalty, 0, 10)

Size is intentionally excluded from Overall to avoid mixing “intrinsic strength” with “scale”.

Stats improve the four underlying scores rather than becoming a separate top-rank penalty system. If a name has extreme upside but poor ROIC, operating margin, dilution, or free-cash-flow yield, those facts should lower Quality and/or Valuation directly. The role system can still label it speculative, but the raw fundamental inputs should already reflect the weaker evidence.

---

# 9. Labels come after scores

Roles are not opinions. The current dashboard label is derived mechanically from absolute score gates. Role indices are still computed by the evaluation engine as diagnostics, but the dashboard bucket does not choose the highest index directly.

Compute indices:

### Core index (durability + scale + reasonable price)

CoreIndex = 0.30·Moat + 0.30·Quality + 0.10·Valuation + 0.30·Size

### Satellite index (theme + upside, still quality-aware)

SatelliteIndex = 0.25·Moat + 0.25·Quality + 0.25·Valuation + 0.25·Upside

### Speculative index (convexity + fragility)

SpecIndex = 0.50·Upside + 0.20·(10−Quality) + 0.20·(10−Moat) + 0.10·(10−Valuation)

### Diversifier index (stability / hedge behavior)

DivIndex = 0.40·Quality + 0.30·Valuation + 0.20·Size + 0.10·(10−Upside)

### Dashboard label rule

The implementation applies explicit gates in priority order so labels do not overstate weak rows.

Current gates:

- Core requires Overall >= `7`, Moat >= `7`, Quality >= `7`, and Valuation >=
  `3.5`.
- Satellite requires Overall >= `5.5`, Moat >= `4`, Quality >= `4`, Valuation
  >= `3`, and either Upside >= `6.2` or Tactical >= `5.5`.
- Defense requires Overall >= `5`, Quality >= `5`, Valuation >= `4`, and Size
  >= `6`.
- Stable-defense fallback requires Overall >= `5`, Moat >= `6`, Quality >=
  `5`, Valuation >= `3`, Tactical < `4.5`, and Upside < `6.2`.
- Speculation applies when Overall <= `4`, Moat <= `4`, Quality <= `4`, or
  Valuation <= `2.5`.

Label priority is explicit: Core first, then Defense, then Satellite, then Speculation. A higher Satellite index is diagnostic only and cannot override a row that passes the Core gate.

---

## Practical anchor philosophy

Anchors are not “statistics.” Anchors are **definitions**:

- the median is the current neutral center of the implemented curve
- extremes are what “notable” means
- the Normal-CDF mapping ensures robustness and saturation with a simple curve

That makes the framework stable, interpretable, and anchored to explicit definitions instead of over-precise directional odds.

---

# 10. Current implementation summary

- Dashboard rows derive deterministic Moat, Quality, Valuation, Upside, Size,
  Tactical, and Overall from current stats.
- Stored LLM scores are allowed by schema but are not needed for displayed
  deterministic scoring.
- Valuation blends legacy mapped valuation with warranted forward P/E.
- Durable growth uses 1Y/3Y financial trend fields when available.
- Peak-cycle risk uses spike-vs-trend, margin-vs-trend, false cheapness,
  momentum, RSI, and IV.
- Role indices label rows; `overall_score` drives ranking.
- Rows without enough stats keep evaluation fields empty instead of inventing
  default fallback scores.

## Current non-goals

- Archetype-specific scoring.
- Source-confidence scoring.
- Portfolio Fit score.
- Bank-specific scoring metrics.
- Commodity or BTC-treasury-specific scoring engines.
- Hybrid labels such as `Core/Satellite`, `Tactical Cyclical`, or `Asset Proxy Speculation`.

## Trend and warranted valuation

Financial history uses StockAnalysis financials pages:

```ts
https://stockanalysis.com/stocks/${ticker.toLowerCase()}/financials/
```

Trend stats are optional. If extraction fails, deterministic scoring still
works from current stats.

Trend fields:

- `revenue_growth_1y`
- `revenue_cagr_3y`
- `fcf_growth_1y`
- `fcf_cagr_3y`
- `gross_margin_median_3y`
- `operating_margin_median_3y`
- `operating_margin_delta_vs_3y`
- `operating_margin_std_3y`
- `fcf_margin_median_3y`
- `shares_change_1y`
- `shares_change_cagr_3y`

Durable growth formula:

```ts
durableGrowth = weightedMeanScore([
  [scoreRevenueGrowth1y, 0.25],
  [scoreRevenueCagr3y, 0.35],
  [scoreFcfGrowth1y, 0.10],
  [scoreFcfCagr3y, 0.20],
  [marginStabilityScore3y, 0.10],
]);
```

Warranted forward P/E formula:

```ts
warrantedFpe =
  BASE_FPE
  * (1 + MOAT_SENSITIVITY * (moat - 6))
  * (1 + QUALITY_SENSITIVITY * (quality - 6))
  * (1 + GROWTH_SENSITIVITY * (durableGrowth - 5))
  * (1 - PEAK_CYCLE_DISCOUNT * peakCycleRisk);

fpeScore = clampScore(
  5 + FPE_RATIO_SCORE_SLOPE * Math.log2(warrantedFpe / actualFpe),
);
```

Current constants:

```ts
BASE_FPE = 18;
MOAT_SENSITIVITY = 0.05;
QUALITY_SENSITIVITY = 0.04;
GROWTH_SENSITIVITY = 0.04;
PEAK_CYCLE_DISCOUNT = 0.35;
FPE_RATIO_SCORE_SLOPE = 2.5;
```

Peak-cycle risk details:

```ts
revenueSpikeVsTrend = revenue_growth_1y - revenue_cagr_3y;
fcfSpikeVsTrend = fcf_growth_1y - fcf_cagr_3y;

growthSpike = weightedMeanUnit([
  [ramp(revenueSpikeVsTrend, 25, 120), 0.70],
  [ramp(fcfSpikeVsTrend, 25, 120), 0.30],
]);

marginSpike = ramp(operating_margin_delta_vs_3y, 5, 25);
marginVolatility = ramp(operating_margin_std_3y, 12, 35);
earningsSpike = ramp(eps_growth, 100, 350);
priceSpike = ramp(change_percent_1y, 150, 500);
rsiSpike = ramp(rsi, 75, 90);
ivSpike = ramp(iv, 70, 100);

cheapForwardPe = inverseRamp(pe_forward, 18, 8);
cheapPeg = inverseRamp(peg, 1, 0.2);

falseCheapness = Math.max(
  cheapForwardPe * Math.max(earningsSpike, growthSpike),
  cheapPeg * Math.max(earningsSpike, growthSpike, priceSpike),
);

cycleRisk = weightedMeanUnit([
  [growthSpike, 0.30],
  [marginSpike, 0.20],
  [falseCheapness, 0.35],
  [priceSpike, 0.15],
  [ivSpike, 0.10],
  [rsiSpike, 0.05],
  [marginVolatility, 0.10],
]);
```

If trend fields are absent and peak-cycle risk is high, durable growth fallback
is capped at `6.5` once `cycleRisk >= 0.60`.

Cycle caps:

```ts
if (cycleRisk >= 0.65) {
  moat = Math.min(moat, 7.50);
  quality = Math.min(quality, 7.30);
  valuation = Math.min(valuation, 6.80);
  overall = Math.min(overall, 7.80);
  upside = Math.min(upside, 7.00);
}

if (cycleRisk >= 0.80) {
  overall = Math.min(overall, 7.00);
}
```

## Shape checks

Use ranking-shape checks rather than exact-score fixtures:

- Durable compounders should outrank high-cycle tactical setups.
- `TACT` can be high while durable `SCORE` stays low.
- ASML should show elite Moat without forcing high Overall.
- MCD should not become Satellite without Upside or Tactical support.
- Expensive rows should not keep very high Upside when Valuation is weak.
