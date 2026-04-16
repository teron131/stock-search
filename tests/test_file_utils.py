import json

from stock_search.file_utils import load_json, write_json


def test_load_json_returns_default_for_missing_and_invalid_files(tmp_path) -> None:
    missing_path = tmp_path / "missing.json"
    assert load_json(missing_path, default={"fallback": True}) == {"fallback": True}

    invalid_path = tmp_path / "invalid.json"
    invalid_path.write_text("{oops", encoding="utf-8")
    assert load_json(invalid_path, default=["fallback"]) == ["fallback"]


def test_write_json_creates_parent_directories_and_writes_latest_payload(tmp_path) -> None:
    target_path = tmp_path / "nested" / "stats.json"

    write_json(target_path, {"ticker": "NVDA", "price": 100.0})
    write_json(target_path, {"ticker": "NVDA", "price": 101.5})

    assert json.loads(target_path.read_text(encoding="utf-8")) == {"ticker": "NVDA", "price": 101.5}
    assert list(target_path.parent.glob(f".{target_path.name}.*.tmp")) == []
