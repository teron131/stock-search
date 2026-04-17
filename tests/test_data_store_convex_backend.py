from __future__ import annotations

from unittest.mock import Mock

import stock_search.api.data_store as data_store


def test_save_stats_map_uses_partial_convex_upserts(monkeypatch) -> None:
    fake_store = Mock()

    monkeypatch.setattr(data_store, "BACKEND", "convex")
    monkeypatch.setattr(data_store, "_convex_store", lambda: fake_store)
    set_generated_at = Mock()
    monkeypatch.setattr(data_store, "set_stats_generated_at_iso", set_generated_at)

    data_store.save_stats_map(
        {
            " nvda ": {"price": 123.45},
            "": {"price": 0},
        }
    )

    fake_store.upsert_stocks.assert_called_once_with([{"ticker": "NVDA", "indicators": {"price": 123.45}}])
    fake_store.save_stocks.assert_not_called()
    set_generated_at.assert_called_once_with()


def test_save_eval_map_uses_partial_convex_upserts(monkeypatch) -> None:
    fake_store = Mock()

    monkeypatch.setattr(data_store, "BACKEND", "convex")
    monkeypatch.setattr(data_store, "_convex_store", lambda: fake_store)

    data_store.save_eval_map(
        {
            " msft ": {"overall_score": 8.8},
            "": {"overall_score": 0},
        }
    )

    fake_store.upsert_stocks.assert_called_once_with([{"ticker": "MSFT", "evaluation": {"overall_score": 8.8}}])
    fake_store.save_stocks.assert_not_called()
