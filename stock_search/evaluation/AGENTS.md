# AGENTS.md (stock_search/evaluation)

This guide is for changes inside `stock_search/evaluation/`.

## Scope

- Evaluation input assembly, normalization, and scoring outputs.
- LLM-backed research integration and deterministic score transforms.
- Bucket/strategy derivation used by portfolio rows.

## High-signal locations

- `stock_search/evaluation/evaluation.py` -> `build_inputs`, `evaluate_asset`, `strategy_label`.
- `stock_search/evaluation/normalization.py` -> `normalize_eval_json`, `bucket_from_eval_json`.
- `stock_search/evaluation/scores.py` -> score primitives and probability modeling.
- `stock_search/evaluation/constants.py` -> calibration ranges and scoring constants.
- `stock_search/evaluation/research.py` -> `run_llm_evaluation` for structured research outputs.

## Key takeaways per location

- `stock_search/evaluation/evaluation.py -> build_inputs` builds `Evaluation` using `StockIndicator` metrics plus LLM research outputs.
- `stock_search/evaluation/evaluation.py -> evaluate_asset` converts normalized probabilities/scores into final strategy-facing result fields.
- `stock_search/evaluation/normalization.py` is the compatibility layer for alias-rich eval payloads from cache/files.
- `stock_search/evaluation/constants.py` is the right place for calibration changes; formula behavior should not drift silently in call sites.

## Project-specific conventions and rationale

- Preserve canonical dashboard-facing fields: `overall_score`, `quality_score`, `valuation_score`, `moat_score`, `upside_score`, `market_cap_score`, `bull_probability`, `bear_probability`.
- Preserve strategy labels used by evaluation outputs and portfolio rows: `Core`, `Satellite`, `Speculation`, `Defense`.
- Keep score outputs bounded and deterministic where formulas are intended to be deterministic.
- Preserve model names unless a coordinated repo-wide change is required.

## Syntax relationship highlights (ast-grep-first)

- `stock_search/evaluation/evaluation.py -> build_inputs` -> uses `stock_search/indicators.py -> StockIndicator`.
- `stock_search/evaluation/evaluation.py -> build_inputs` -> calls `stock_search/evaluation/research.py -> run_llm_evaluation`.
- `stock_search/portfolio.py -> _build_row` -> calls `stock_search/evaluation/normalization.py -> normalize_eval_json` and derives eval bucket fallback.
- `stock_search/portfolio.py -> _build_row` -> mixes normalized eval and deterministic fallback scores for row output.

## General approach (not rigid checklist)

- Change constants first when shifting calibration behavior, then update formulas only when required.
- Keep scoring functions pure and easy to reason about; avoid hidden side effects.
- Validate normalization behavior against mixed/legacy `eval.json` payload shapes.

## Validation commands

- Normalization sanity check:
  - `uv run python -c "from stock_search.evaluation.normalization import normalize_eval_json; print(normalize_eval_json({'score':7,'bull_probability':0.6,'bear_probability':0.2}))"`
- Formatting/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
