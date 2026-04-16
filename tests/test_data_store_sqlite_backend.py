from datetime import datetime

import stock_search.api.data_store as data_store


def configure_sqlite_backend(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(data_store, "BACKEND", "sqlite")
    monkeypatch.setattr(data_store, "DATA_SQLITE_PATH", tmp_path / "stock_search.db")
    data_store._sqlite_store.cache_clear()


def test_load_positions_reads_saved_sqlite_rows(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)

    data_store.save_positions([{"ticker": "nvda"}, "skip", {"ticker": "MSFT"}])

    assert data_store.load_positions() == [{"ticker": "NVDA"}, {"ticker": "MSFT"}]


def test_load_eval_map_reads_saved_sqlite_rows(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)
    data_store.save_eval_map(
        {
            "nvda": {"overall_score": 9.1},
            " msft ": {"overall_score": 7.8},
            "": {"overall_score": 0},
        }
    )

    assert data_store.load_eval_map() == {
        "NVDA": {"overall_score": 9.1},
        "MSFT": {"overall_score": 7.8},
    }


def test_load_ticker_context_uses_normalized_ticker_and_deduplicated_labels(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)
    data_store.save_positions([{"ticker": "NVDA", "quantity": 10}])
    data_store.save_stats_map(
        {
            "nvda": {
                "price": 123.45,
                "industry_labels": [" AI ", "AI", "", 42, "Semis"],
            }
        }
    )

    positions, indicators, labels = data_store.load_ticker_context(" nvda ")

    assert positions == [{"ticker": "NVDA", "quantity": 10}]
    assert indicators["price"] == 123.45
    assert labels == ["AI", "Semis"]


def test_save_stocks_persists_indicator_and_evaluation_maps_in_sqlite(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)

    data_store.save_stocks(
        {
            " nvda ": {
                "indicators": {"price": 123.45, "market_cap": 1_000_000_000},
                "evaluation": {"overall_score": 8.9},
                "labels": ["Semis"],
            }
        }
    )

    assert data_store.load_stats_map() == {"NVDA": {"price": 123.45, "market_cap": 1_000_000_000}}
    assert data_store.load_eval_map() == {"NVDA": {"overall_score": 8.9}}
    assert data_store.load_stocks() == {
        "NVDA": {
            "indicators": {"price": 123.45, "market_cap": 1_000_000_000},
            "evaluation": {"overall_score": 8.9},
            "labels": ["Semis"],
        }
    }


def test_load_stock_families_can_filter_to_specific_tickers_in_sqlite(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)
    data_store.save_stocks(
        {
            "nvda": {
                "indicators": {"price": 123.45},
                "evaluation": {"overall_score": 8.9},
                "labels": ["Semis"],
            },
            "msft": {
                "indicators": {"price": 234.56},
                "evaluation": {"overall_score": 7.5},
                "labels": ["Software"],
            },
        }
    )

    stats_map, eval_map = data_store.load_stock_families(tickers=[" msft ", "", "missing"])

    assert stats_map == {"MSFT": {"price": 234.56}}
    assert eval_map == {"MSFT": {"overall_score": 7.5}}


def test_stats_generated_at_iso_reads_sqlite_meta_value(tmp_path, monkeypatch) -> None:
    configure_sqlite_backend(tmp_path, monkeypatch)
    data_store.set_stats_generated_at_iso("2026-04-16T12:00:00+00:00")

    generated_at = data_store.stats_generated_at_iso()

    assert generated_at == "2026-04-16T12:00:00+00:00"
    assert datetime.fromisoformat(generated_at).tzinfo is not None
