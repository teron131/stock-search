from stock_search.evaluation.normalization import bucket_from_eval_json
from stock_search.evaluation.scores import calculate_strategy_indices


def test_calculate_strategy_indices_penalizes_fragile_inputs_for_speculation() -> None:
    indices = calculate_strategy_indices(
        {
            "moat_score": 9.5,
            "quality_score": 9.5,
            "valuation_score": 7.5,
            "upside_score": 9.6,
            "size_score": 10.0,
        },
        edge=4.2,
    )

    assert indices["core"] is not None
    assert indices["speculative"] is not None
    assert indices["core"] > indices["speculative"]


def test_bucket_from_eval_json_keeps_nvda_like_profile_out_of_speculation() -> None:
    bucket = bucket_from_eval_json(
        "NVDA",
        {
            "overall_score": 9.0,
            "quality_score": 9.5,
            "valuation_score": 7.5,
            "moat_score": 9.5,
            "upside_score": 9.6,
            "market_cap_score": 10.0,
            "bull_probability": 0.62,
            "bear_probability": 0.2,
        },
    )

    assert bucket == "Core"
