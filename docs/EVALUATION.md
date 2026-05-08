## Evaluation Framework v4 — Anchor-Calibrated Logistic Scorecard ⚓️📈

This framework turns messy investing judgments into a **consistent scorecard**: core fundamentals (moat/quality/valuation/upside/size), **game-like directional odds** (bull/bear), and **roles** (core/satellite/speculative/diversifier) that are assigned **after** scoring.

The key upgrade here is the mapping: instead of linear scaling or Normal-CDF “sigma” thinking, the system uses an **anchor-calibrated logistic function** so the score behavior is **explicitly defined** by remembered examples and a “good standard” median.

---

# 1) What the framework produces ✅

For each asset:

### A) Fundamental scores (0–10)

- **Moat**: replaceability under real constraints
- **Quality**: durability of economics / execution
- **Valuation**: attractiveness of price relative to growth/quality
- **Upside**: payoff size if the thesis plays out
- **Size**: market-cap scale (robustness proxy)

### B) Directional odds (game-like)

- **Bull score (0–10)** ≈ pseudo-probability of being **up** in 12 months
- **Bear score (0–10)** ≈ pseudo-probability of being **down** in 12 months
- **Flat probability** is implicit

Derived:

- **Edge** = Bull − Bear
- **Confidence** = |Bull − Bear|

### C) Ranking + roles

- **Overall score** = average of (Moat, Quality, Valuation, Upside)
- **Role indices**: Core / Satellite / Speculative / Diversifier
- **Label** = argmax(role indices)
- **FOMO flag** (overlay)
- Optional **Elo-style normalization** (additive rating deltas)

---

# 2) Anchors: the explicit definitions ⚓️

Every mapped metric has **three anchors**:

- **Low**: notably good / cheap / strong (memorable best examples)
- **Median**: “good standard” (personal bar or S&P-ish median)
- **High**: notably stretched / weak (memorable worst examples)

Because the mapping is S-curved, the **median anchor dominates** how most names score; extremes mostly control saturation.

---

# 3) Mapping function: logistic CDF from anchors 📐

### 3.1 Logistic CDF (the squashing function)

The logistic CDF is:

( \sigma(z) = \frac{1}{1 + e^{-z}} )

A score is simply:

Score(x) = 10 · p(x), where p(x) ∈ [0,1]

### 3.2 The anchor-fit idea (no “sigma” needed)

Instead of pretending metrics are Normal with a standard deviation, anchors are treated as **calibration targets**:

- Low anchor (x_L) maps to target percentile/probability (p_L)
- Median anchor (x_M) maps to (p_M)
- High anchor (x_H) maps to (p_H)

“Probability” here means “position on the 0–1 score curve”, not a market probability.

A convenient inverse is the **logit**:

logit(p) = ln(p/(1−p))

### 3.3 Piecewise logistic (recommended) ✅

A single logistic has only 2 parameters, so it cannot perfectly match 3 anchors. The clean solution is **piecewise logistic**: one slope left of the median and another slope right of the median—exactly matching all three anchors.

Let:

- g(p) = logit(p)
- z_M = g(p_M)

Left scale: ( s_L = \frac{x_M - x_L}{z_M - g(p_L)} )

Right scale: ( s_R = \frac{x_H - x_M}{g(p_H) - z_M} )

Then for any x:

- If x ≤ x_M: ( z = z_M + \frac{x - x_M}{s_L} )
- If x ≥ x_M: ( z = z_M + \frac{x - x_M}{s_R} )

Finally:

- p = σ(z)
- Score = 10·p, clamped to [0,10]

### 3.4 Monotonic direction (good-is-high vs good-is-low)

Some metrics are “higher is better” (growth, upside). Others are “lower is better” (P/E, PEG).

Two equivalent ways to handle “lower is better”:

- Negate the input: score(−x) using the same anchors, or
- Swap anchors / flip target p’s so “cheap” maps to higher p.

---

# 4) Target score levels at anchors (synthetic percentiles) 🎯

To make the median represent a “good standard” (not a neutral 5/10), set:

### Default target mapping (sensible, stable)

- **Low (notably good)**: p_L = 0.85 → score 8.5
- **Median (good standard)**: p_M = 0.65 → score 6.5
- **High (stretched/weak)**: p_H = 0.25 → score 2.5

This creates a practical behavior:

- names around the “good” median cluster around 6–7
- extremes saturate without dominating the entire ranking

For metrics where “higher is worse” (P/E), those p targets are applied after inversion so “cheap” still maps to 8.5.

---

# 5) Full anchor list (complete) ✅

These are the **metrics that require anchors**.

## 5.1 Size anchors (Market cap, USD)

- **Min**: $10B
- **Median**: $800B
- **Max**: **$4.5T** (NVDA cap ceiling anchor)

## 5.2 Valuation anchors

These are “lower is better” metrics (after inversion they become “higher is better” on the score curve).

- **PEG**: 0.7 / 2.0 / 4.0
- **Trailing P/E**: 12 / 30 / 80
- **Forward P/E**: 10 / 28 / 65
- **Debt/equity %**: 0 / 100 / 300
- **FCF yield %**: -5 / 2 / 8
- **Operating margin %**: -15 / 15 / 35
- **ROIC %**: 0 / 12 / 30

## 5.3 Growth anchor

“Higher is better”

- **Earnings growth (YoY)**: -0.10 / 0.20 / 0.50
- **Revenue growth (YoY %)**: -10 / 12 / 35
- **Gross margin %**: 20 / 50 / 75
- **Operating margin %**: -15 / 15 / 35
- **ROIC %**: 0 / 12 / 30

## 5.4 Upside anchor (Analyst target upside)

“Higher is better”

- **Target upside %**: -0.20 / 0.15 / 0.50

## 5.5 Analyst rating anchor (1–5 scale)

“Higher is better”

- **Rating**: 1.0 / 3.5 / 5.0

## 5.6 Game-probability anchors (market direction)

These are intentionally tight because markets are noisy.

- **Probability**: 0.50 / 0.55 / 0.60

---

# 6) Suggested anchor presets (sensible values) ⚙️

Two complete presets, matching two different philosophies.

## Preset A — Quality-bar / Mega-cap-friendly (recommended)

Median reflects “good by high-conviction standards,” not market average.

| Metric          |  Low | Median (good) |      High |
| --------------- | ---: | ------------: | --------: |
| Market cap      | $10B |         $800B | **$4.5T** |
| PEG             |  0.7 |           2.0 |       4.0 |
| Trailing P/E    |   12 |            30 |        80 |
| Forward P/E     |   10 |            28 |        65 |
| Revenue growth  |  -10 |            12 |        35 |
| Gross margin    |   20 |            50 |        75 |
| Operating margin |  -15 |            15 |        35 |
| Debt/equity     |    0 |           100 |       300 |
| FCF yield       |   -5 |             2 |         8 |
| Target upside   |  -20 |            15 |        50 |
| Probability     | 0.50 |          0.56 |      0.62 |
| Rating (1–5)    |  1.0 |           3.7 |       5.0 |

## Preset B — Broad-market neutral

Median reflects a more index-like standard.

| Metric          |  Low | Median |      High |
| --------------- | ---: | -----: | --------: |
| Market cap      |  $3B |  $200B | **$4.5T** |
| PEG             |  0.7 |    1.8 |       4.0 |
| Trailing P/E    |   10 |     22 |        45 |
| Forward P/E     |    9 |     20 |        40 |
| Revenue growth  |   -5 |      8 |        25 |
| Gross margin    |   15 |     40 |        65 |
| Operating margin |  -10 |     10 |        25 |
| Debt/equity     |    0 |    100 |       300 |
| FCF yield       |   -6 |      2 |         8 |
| Target upside   |  -15 |     12 |        40 |
| Probability     | 0.50 |   0.55 |      0.60 |
| Rating (1–5)    |  1.0 |    3.5 |       5.0 |

---

# 7) Score definitions (what each score means) 🧠

## 7.1 Moat (0–10)

“How hard is it to replace this under real constraints?”

- switching costs, integration depth, ecosystem lock-in
- regulatory/security/procurement barriers
- data/feedback loops (when not easily replicated)
- physics bottlenecks / supply chain choke points

### Commodities: moat is scarcity + role (not competition) 🪙

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
- **Interest coverage**: whether debt service is covered by operating economics.
- **Shareholder yield / dilution**: whether per-share owners are being rewarded or diluted.
- **Piotroski F-Score**: compact financial-health sanity check.

Interpretation rules:

- High gross margin should not rescue deeply negative operating margin.
- Low debt/equity should not rescue poor interest coverage.
- Growth should be discounted when it is bought with heavy dilution.
- F-Score is not a thesis by itself; it is a useful red/yellow/green health check.
- Negative revenue growth, negative operating margin, and negative FCF yield are real negative contributions, not merely low positive subscores.
- If fewer than two comparable quality stats are available, the market-derived quality signal should stay unknown rather than letting one stat produce a false high-confidence score.

## 7.3 Valuation (0–10) — weighted signed blend

Valuation is not a single metric. It is a blend of mapped stat contributions:

- PEG score (largest weight)
- trailing P/E score
- forward P/E score
- EV/Sales score when earnings-based metrics are missing or misleading
- FCF yield score when market cap and free cash flow are available
- earnings growth score (small weight, to avoid punishing genuine growth)

Suggested contribution multipliers (stable and interpretable):

- PEG 0.40
- trailing P/E 0.20
- forward P/E 0.15
- EV/Sales 0.10–0.20 when PE/PEG evidence is weak
- FCF yield 0.15
- debt/equity 0.10
- operating margin 0.25 as a valuation viability check
- ROIC 0.15 as a valuation viability check

Implemented multipliers use `1.0` as normal strength while preserving the relative priorities above:

- PEG 2.00
- trailing P/E 1.00
- forward P/E 0.75
- FCF yield 0.75
- debt/equity 0.50
- operating margin 1.25
- ROIC 0.75

Market-derived quality uses these contribution multipliers:

- revenue growth 0.30
- gross margin 0.25
- operating margin 0.35
- ROIC 0.10

Implemented multipliers:

- revenue growth 1.20
- gross margin 1.00
- operating margin 1.40
- ROIC 0.40

Each available stat is mapped as a **signed contribution** around a neutral base, optionally multiplied, then averaged:

StatContribution = curve(metric, anchors) ∈ roughly [-10, +10]

MetricScore = clamp(5 + mean(StatContribution × multiplier), 0, 10)

The final score remains a normal 0–10 score, but weak components can now subtract from the base instead of merely landing at a harmless low positive score. Values beyond the weak anchor can extend further negative before the final clamp. This matters for expensive valuation, negative growth, negative operating margins, and negative free-cash-flow yield.

If some inputs are missing, the mean is taken over the available components only. Missing data should reduce confidence, not automatically count as a zero contribution. Non-positive P/E or PEG values are not cheap; they represent loss-making or non-meaningful multiples and should map to the weak side of that component.

Evidence quality matters. A great forward P/E alone should not create a high valuation score when trailing P/E, PEG, EV/FCF, or FCF yield are missing. In that case, valuation can still be positive, but confidence should be lower and EV/Sales should carry more weight.

## 7.4 Upside (0–10) — three-channel blend

Upside merges:

1. **Analyst target upside** (mapped via upside anchors)
2. **Analyst consensus rating** (mapped via rating anchors)
3. **Forward outlook score** (structured subjective/LLM score on 0–10)

Combine by averaging available channels (or explicit weights if desired).

## 7.5 Size (0–10)

Size maps market cap on a log-like perception scale (because $4T is not “4×” $1T in practical robustness). Anchors define the saturation behavior.

---

# 8) Bull/Bear pseudo-probabilities (12-month “win-rate”) 🎮

Bull and Bear are produced from two sources:

- **Market behavior signal** (momentum-like input normalized to a 0–1 probability proxy)
- **Forward outlook bull/bear probabilities** (subjective/LLM or structured)

Then mapped using the **Probability anchors**.

Convert:

- p_up = Bull/10
- p_down = Bear/10
- p_flat = max(0, 1 − p_up − p_down)

### Game tiers (for Bull score)

- **5.5–5.8**: already high edge
- **5.9–6.2**: very high
- **6.3–6.7**: smurfing
- **6.8+**: rare / dislocation-level

---

# 9) Overall ranking metric 🏁

Overall = (Moat + Quality + Valuation + Upside) / 4

Size and Bull/Bear are intentionally excluded from Overall to avoid mixing “intrinsic strength” with “timing” and “scale”.

Stats should improve the four underlying scores rather than becoming a separate top-rank penalty system. If a name has extreme upside but poor ROIC, operating margin, interest coverage, dilution, or F-Score, those facts should lower Quality and/or Valuation directly. The role system can still label it speculative, but the raw fundamental inputs should already reflect the weaker evidence.

---

# 10) Labels come after scores (role indices) 🏷️

Roles are not opinions. They are derived mechanically from scores.

First compute:

- Edge = Bull − Bear
- EdgeComp = 5 + 0.5·Edge (a 0–10-ish tilt term)

Then compute indices:

### Core index (durability + scale + reasonable price)

CoreIndex = 0.35·Moat + 0.35·Quality + 0.15·Valuation + 0.10·Size + 0.05·EdgeComp

### Satellite index (theme + upside, still quality-aware)

SatelliteIndex = 0.30·Moat + 0.25·Quality + 0.10·Valuation + 0.25·Upside + 0.10·EdgeComp

### Speculative index (convexity + fragility)

SpecIndex = 0.45·Upside + 0.20·(10−Quality) + 0.20·(10−Moat) + 0.15·(10−Valuation)

### Diversifier index (stability / hedge behavior)

DivIndex = 0.45·Quality + 0.25·Valuation + 0.20·Size + 0.10·(10−Upside)

### Label rule

Label = argmax(CoreIndex, SatelliteIndex, SpecIndex, DivIndex)

(If desired, additional “gates” can be layered later, but the core philosophy is score → index → label.)

---

# 11) FOMO flag (overlay) 🫠

A behavior-risk overlay triggers when:

- Valuation ≤ 3.0
- Upside ≥ 8.0
- Bull ≤ 5.8

Interpretation: compelling story + expensive pricing + odds not exceptional.

---

# 12) Optional Elo-style normalization (additive comparison) 🎮📈

For a probability p:

ΔElo = 400 · log10(p/(1−p))

Variants:

- **Classic**: p = p_up
- **Directional**: p = p_up vs p_down → 400·log10(p_up/p_down)
- **Draw-aware**: expected score S = p_up + 0.5·p_flat, then ΔElo(S)

This turns “slight win-rate edges” into a clean additive scale.

---

## Practical anchor philosophy (the guiding principle) 🧭

Anchors are not “statistics.” Anchors are **definitions**:

- the median is what “good” means
- extremes are what “notable” means
- the logistic mapping ensures robustness and saturation without needing any assumed distribution

That makes the framework stable, interpretable, and aligned with a game-like view where **small edges matter and giant edges are rare**.

---

# 13) Implementation alignment notes 🔍

The TypeScript implementation should be checked against this document after migrations. As of the current TS port, these are the important alignment points:

## Correctly aligned

- Overall is computed as the average of Moat, Quality, Valuation, and Upside.
- Size and Bull/Bear are excluded from Overall.
- Role indices are computed after scoring from Core / Satellite / Speculative / Diversifier formulas.
- Core and Satellite include EdgeComp; Speculative and Diversifier do not.
- Quality blends research quality with market-derived quality.
- Upside blends analyst target upside, analyst rating, and forward outlook when available.

## Known drift / cleanup targets

- The document describes a piecewise logistic anchor map where the “good” median maps around 6.5. The TS code currently uses a Normal-CDF S-curve (`zScoreMap`) where the median maps to 5.0.
- Market cap max is documented as $4.5T in presets, while TS currently uses $4T.
- TS valuation currently uses PEG, trailing P/E, forward P/E, debt/equity, FCF yield, operating margin, and ROIC. The older doc wording mentioned earnings growth instead of the current debt/FCF additions.
- TS quality signal currently uses revenue growth, gross margin, operating margin, and ROIC before blending with research quality. It does not yet include interest coverage, dilution/shareholder yield, or Piotroski F-Score.
- Dashboard rank currently sorts by `overall_score`; role indices label the asset but do not drive table rank.
- Dashboard row merging has a separate indicator fallback path for rows without stored evaluation. That fallback uses simpler linear maps over PE/FWD_PE, revenue growth, gross margin, and median upside, with a default moat of 5. It is not the full evaluation engine.

These are not all bugs. Some are intentional simplifications from the migration period. But the next scoring enhancement should make the implementation explicit: either adopt the documented logistic anchor behavior or update this document to bless the Normal-CDF behavior.
