from concurrent.futures import ThreadPoolExecutor
import os
import re

from docling.document_converter import DocumentConverter
from langchain.tools import tool


def _clean_markdown(markdown: str) -> str:
    """Clean up markdown by removing image comments and excess whitespace."""
    markdown = re.sub(r"^<!-- image -->$", "", markdown, flags=re.MULTILINE)
    markdown = re.sub(r" {2,}", " ", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return markdown


def webloader(urls: str | list[str]) -> list[str | None]:
    """Load and process website content from URLs into markdown."""
    converter = DocumentConverter()

    def _convert(url: str) -> str | None:
        try:
            markdown = converter.convert(url).document.export_to_markdown()
            return _clean_markdown(markdown) if markdown else None
        except Exception:
            return None

    urls = [urls] if isinstance(urls, str) else urls

    max_workers = min(len(urls), os.cpu_count(), 10)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        return list(executor.map(_convert, urls))


@tool
def webloader_tool(urls: list[str]) -> list[str]:
    """Load the web content from the given URLs."""
    return webloader(urls)
