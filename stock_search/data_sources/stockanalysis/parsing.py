"""Pure parsing helpers for StockAnalysis page content."""

from __future__ import annotations

import re

from pydantic import BaseModel
from selectolax.lexbor import LexborHTMLParser

COMPACT_NUMBER_SUFFIXES = {
    "K": 1_000.0,
    "M": 1_000_000.0,
    "B": 1_000_000_000.0,
    "T": 1_000_000_000_000.0,
}
NULLISH_TEXT = {"", "-", "n/a", "N/A", "na", "NA"}


def coalesce(primary: float | None, fallback: float | None) -> float | None:
    return primary if primary is not None else fallback


def to_percent(value: float | None) -> float | None:
    return value * 100 if value is not None else None


def clean_symbol(raw_symbol: str) -> str:
    symbol = raw_symbol.strip()
    if symbol.startswith("$"):
        return symbol[1:]
    if symbol.startswith("!") and "/" in symbol:
        return symbol.split("/", maxsplit=1)[1]
    if symbol.startswith("!"):
        return symbol[1:]
    return symbol


def has_model_data(model: BaseModel) -> bool:
    return any(value is not None for value in model.model_dump().values())


def normalize_cell_text(text: str) -> str:
    return " ".join(text.split())


def clean_numeric_text(raw_value: str) -> str | None:
    text = raw_value.strip()
    if text in NULLISH_TEXT:
        return None
    if text.startswith("(") and text.endswith(")"):
        text = f"-{text[1:-1]}"
    return text.replace(",", "").replace("$", "").replace("+", "")


def parse_number(raw_value: str) -> float | None:
    text = clean_numeric_text(raw_value)
    if text is None:
        return None
    multiplier = 1.0
    suffix = text[-1].upper()
    if suffix in COMPACT_NUMBER_SUFFIXES:
        multiplier = COMPACT_NUMBER_SUFFIXES[suffix]
        text = text[:-1]
    try:
        return float(text) * multiplier
    except ValueError:
        return None


def parse_percent_ratio(raw_value: str) -> float | None:
    text = clean_numeric_text(raw_value)
    if text is None:
        return None
    if text.endswith("%"):
        text = text[:-1]
    try:
        return float(text) / 100.0
    except ValueError:
        return None


def parse_percent_points(raw_value: str) -> float | None:
    text = clean_numeric_text(raw_value)
    if text is None:
        return None
    if text.endswith("%"):
        text = text[:-1]
    try:
        return float(text)
    except ValueError:
        return None


def extract_quote_scalar(quote_block: str, key: str) -> str | None:
    match = re.search(rf"{re.escape(key)}:(\"[^\"]*\"|[^,]+)", quote_block)
    if not match:
        return None
    return match.group(1).strip().strip('"')


def extract_script_block(
    soup: LexborHTMLParser | None,
    *,
    pattern: re.Pattern[str],
    required_fragments: tuple[str, ...] = (),
) -> str | None:
    script_text = _extract_script_text(
        soup,
        required_fragments=required_fragments,
    )
    if not script_text:
        return None

    block_match = pattern.search(script_text)
    if not block_match:
        return None
    return block_match.group(1)


def _extract_script_text(
    soup: LexborHTMLParser | None,
    *,
    required_fragments: tuple[str, ...],
) -> str | None:
    if soup is None:
        return None

    for script_tag in soup.css("script"):
        script_text = script_tag.text()
        if all(fragment in script_text for fragment in required_fragments):
            return script_text
    return None


def extract_table_rows(
    soup: LexborHTMLParser,
    *,
    cell_selector: str,
    keep_first: bool,
) -> dict[str, str]:
    rows: dict[str, str] = {}
    for row in soup.css("table tr"):
        cells = row.css(cell_selector)
        if len(cells) < 2:
            continue
        label = normalize_cell_text(cells[0].text(separator=" ", strip=True))
        value = normalize_cell_text(cells[1].text(separator=" ", strip=True))
        if label and value:
            if keep_first and label in rows:
                continue
            rows[label] = value
    return rows


def build_model_from_rows[MODEL_TYPE](
    rows: dict[str, str],
    *,
    model_type: type[MODEL_TYPE],
    field_specs: dict[str, tuple[str, str]],
) -> MODEL_TYPE:
    parser_by_name = {
        "parse_number": parse_number,
        "parse_percent_ratio": parse_percent_ratio,
        "parse_percent_points": parse_percent_points,
    }
    payload = {field_name: parser_by_name[parser_name](rows.get(label, "")) for field_name, (label, parser_name) in field_specs.items()}
    return model_type(**payload)
