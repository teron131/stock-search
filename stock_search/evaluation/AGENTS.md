# AGENTS.md (stock_search/evaluation)

This guide is for changes inside `stock_search/evaluation/`.

## Scope

- Scoring math, normalization, and evaluation assembly.
- Model-ready evaluation payload shaping.

Primary files:

- `stock_search/evaluation/evaluation.py` -> `build_inputs`, `evaluate_asset`
- `stock_search/evaluation/normalization.py` -> eval JSON normalization/bucketing
- `stock_search/evaluation/scores.py` -> scoring primitives
- `stock_search/evaluation/constants.py` -> calibration constants

## Responsibilities

- Convert indicators + optional research signals into consistent 0-10 scores.
- Normalize flexible `eval.json` keys/aliases into canonical fields.
- Derive strategy bucket labels from index scores.

## Invariants

- Keep normalization aliases compatible with stored `eval.json` variants:
  - `bull` <-> `bull_probability`
  - `bear` <-> `bear_probability`
  - `overall` <-> `score`
- Preserve output contract used by dashboard rows:
  - `overall`, `quality`, `valuation`, `moat`, `upside`, `bull`, `bear`.
- Keep calibration changes explicit in `constants.py`; avoid hidden shifts in formulas.

## Safe Change Pattern

1. Update constants first when changing behavior.
2. Keep scoring functions pure and deterministic.
3. Re-run normalization path against sample eval payloads.

## Validation

- Scripted sanity check:
  - `uv run python -c "from stock_search.evaluation.normalization import normalize_eval_json; print(normalize_eval_json({'score':7,'bull_probability':0.6,'bear_probability':0.2}))"`
- Format/lint:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
