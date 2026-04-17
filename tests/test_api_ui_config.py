from pathlib import Path

from stock_search.api import config as api_config


def test_get_ui_dir_prefers_dist_when_index_exists(tmp_path: Path) -> None:
    ui_dir = tmp_path / "ui"
    dist_dir = ui_dir / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text("<html></html>", encoding="utf-8")

    assert api_config.get_ui_dir(ui_dir) == dist_dir
    assert api_config.get_index_file(ui_dir) == dist_dir / "index.html"


def test_get_ui_dir_falls_back_to_raw_ui_when_dist_is_missing(
    tmp_path: Path,
) -> None:
    ui_dir = tmp_path / "ui"
    ui_dir.mkdir()
    (ui_dir / "index.html").write_text("<html></html>", encoding="utf-8")

    assert api_config.get_ui_dir(ui_dir) == ui_dir
    assert api_config.get_index_file(ui_dir) == ui_dir / "index.html"
