from datetime import datetime
import json

import stock_search.api.data_store as data_store


def configure_file_backend(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(data_store, "BACKEND", "file")
    monkeypatch.setattr(data_store, "PORTFOLIO_PATH", tmp_path / "portfolio.json")
    monkeypatch.setattr(data_store, "STATS_PATH", tmp_path / "stats.json")
    monkeypatch.setattr(data_store, "EVAL_PATH", tmp_path / "eval.json")


def write_json(path, payload) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_load_positions_supports_list_and_legacy_positions_wrappers(tmp_path, monkeypatch) -> None:
    configure_file_backend(tmp_path, monkeypatch)

    write_json(data_store.PORTFOLIO_PATH, [{"ticker": "NVDA"}, "skip", {"ticker": "MSFT"}])
    assert data_store.load_positions() == [{"ticker": "NVDA"}, {"ticker": "MSFT"}]

    write_json(data_store.PORTFOLIO_PATH, {"positions": [{"ticker": "AAPL"}, 5, {"ticker": "META"}]})
    assert data_store.load_positions() == [{"ticker": "AAPL"}, {"ticker": "META"}]


def test_load_eval_map_normalizes_list_payloads_into_ticker_map(tmp_path, monkeypatch) -> None:
    configure_file_backend(tmp_path, monkeypatch)
    write_json(
        data_store.EVAL_PATH,
        [
            {"ticker": "nvda", "overall_score": 9.1},
            {"ticker": " msft ", "overall_score": 7.8},
            {"ticker": "", "overall_score": 0},
            "skip",
        ],
    )

    assert data_store.load_eval_map() == {
        "NVDA": {"ticker": "nvda", "overall_score": 9.1},
        "MSFT": {"ticker": " msft ", "overall_score": 7.8},
    }


def test_load_ticker_context_uses_normalized_ticker_and_deduplicated_labels(tmp_path, monkeypatch) -> None:
    configure_file_backend(tmp_path, monkeypatch)
    write_json(data_store.PORTFOLIO_PATH, {"positions": [{"ticker": "NVDA", "quantity": 10}]})
    write_json(
        data_store.STATS_PATH,
        {
            "nvda": {
                "price": 123.45,
                "industry_labels": [" AI ", "AI", "", 42, "Semis"],
            }
        },
    )

    positions, indicators, labels = data_store.load_ticker_context(" nvda ")

    assert positions == [{"ticker": "NVDA", "quantity": 10}]
    assert indicators["price"] == 123.45
    assert labels == ["AI", "Semis"]


def test_save_stocks_splits_indicator_and_evaluation_maps_for_file_backend(tmp_path, monkeypatch) -> None:
    configure_file_backend(tmp_path, monkeypatch)

    data_store.save_stocks(
        {
            " nvda ": {
                "indicators": {"price": 123.45, "market_cap": 1_000_000_000},
                "evaluation": {"overall_score": 8.9},
                "labels": ["ignored"],
            }
        }
    )

    assert json.loads(data_store.STATS_PATH.read_text(encoding="utf-8")) == {"NVDA": {"price": 123.45, "market_cap": 1_000_000_000}}
    assert json.loads(data_store.EVAL_PATH.read_text(encoding="utf-8")) == {"NVDA": {"overall_score": 8.9}}


def test_stats_generated_at_iso_reads_stats_file_mtime_in_file_mode(tmp_path, monkeypatch) -> None:
    configure_file_backend(tmp_path, monkeypatch)
    data_store.STATS_PATH.write_text("{}", encoding="utf-8")

    generated_at = data_store.stats_generated_at_iso()

    assert generated_at is not None
    assert datetime.fromisoformat(generated_at).tzinfo is not None
