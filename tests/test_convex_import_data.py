import pytest

from stock_search.models.convex import import_data


def test_run_import_from_local_files_delegates_to_sqlite_entrypoint(tmp_path, monkeypatch) -> None:
    expected = {"positions": 2, "stocks": 3}
    db_path = tmp_path / "local.db"

    def fake_run_import_from_local_store(*, db_path):
        assert db_path == db_path_expected
        return expected

    db_path_expected = db_path
    monkeypatch.setattr(import_data, "run_import_from_local_store", fake_run_import_from_local_store)

    assert import_data.run_import_from_local_files(db_path=db_path) == expected


def test_run_import_from_local_files_rejects_removed_json_arguments(tmp_path) -> None:
    with pytest.raises(ValueError, match="JSON-based import arguments were removed"):
        import_data.run_import_from_local_files(portfolio_path=tmp_path / "portfolio.json")
