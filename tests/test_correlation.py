"""Regression tests for the correlation report helpers."""

import numpy as np
import pandas as pd

from stock_search.correlation import _build_sleeve_weight_recommendations


def test_sleeve_recommendations_fall_back_to_normal_when_no_tail_matrix(monkeypatch) -> None:
    tickers = ["AAA", "BBB"]
    normal_matrix = pd.DataFrame(
        [[1.0, 0.20], [0.20, 1.0]],
        index=tickers,
        columns=tickers,
    )

    monkeypatch.setattr(
        "stock_search.correlation._resolve_ticker_markers",
        lambda ticker: ["sleeve:test"],
    )

    recommendations = _build_sleeve_weight_recommendations(
        tickers=tickers,
        normal_correlation_matrix=normal_matrix,
    )

    assert len(recommendations) == 1
    recommendation = recommendations[0]
    assert recommendation["correlation_basis"] == "normal"
    assert recommendation["normal_mean_pair_correlation"] == 0.2
    assert recommendation["tail_mean_pair_correlation"] is None
    assert recommendation["mean_pair_correlation"] == 0.2


def test_sleeve_recommendations_report_tail_basis_when_tail_is_higher(monkeypatch) -> None:
    tickers = ["AAA", "BBB"]
    normal_matrix = pd.DataFrame(
        [[1.0, 0.20], [0.20, 1.0]],
        index=tickers,
        columns=tickers,
    )
    tail_raw_matrix = pd.DataFrame(
        [[1.0, 0.80], [0.80, 1.0]],
        index=tickers,
        columns=tickers,
    )

    monkeypatch.setattr(
        "stock_search.correlation._resolve_ticker_markers",
        lambda ticker: ["sleeve:test"],
    )

    recommendations = _build_sleeve_weight_recommendations(
        tickers=tickers,
        normal_correlation_matrix=normal_matrix,
        tail_raw_correlation_matrix=tail_raw_matrix,
    )
    normal_only_recommendations = _build_sleeve_weight_recommendations(
        tickers=tickers,
        normal_correlation_matrix=normal_matrix,
    )

    assert len(recommendations) == 1
    recommendation = recommendations[0]
    normal_only_recommendation = normal_only_recommendations[0]
    assert recommendation["correlation_basis"] == "tail_raw"
    assert recommendation["normal_mean_pair_correlation"] == 0.2
    assert recommendation["tail_mean_pair_correlation"] == 0.8
    assert recommendation["mean_pair_correlation"] == 0.8

    expected_multiplier = float(np.sqrt((1.0 + 0.8) / 2.0))
    assert recommendation["diversification_multiplier"] == expected_multiplier
    assert recommendation["recommended_total_weight"] < normal_only_recommendation["recommended_total_weight"]
