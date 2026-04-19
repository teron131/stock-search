from stock_search.news.providers import yahoofinance


class _FakeSearch:
    def __init__(self, *, query: str, max_results: int) -> None:
        self.query = query
        self.max_results = max_results
        self.news = []


def test_get_news_yfinance_caps_max_results_to_provider_limit(monkeypatch) -> None:
    search_calls: list[tuple[str, int]] = []

    def fake_search(*, query: str, max_results: int) -> _FakeSearch:
        search_calls.append((query, max_results))
        return _FakeSearch(query=query, max_results=max_results)

    monkeypatch.setattr(yahoofinance.yf, "Search", fake_search)

    result = yahoofinance.get_news_yfinance("NVDA", max_results=999)

    assert result == []
    assert search_calls == [("NVDA", yahoofinance.YFINANCE_MAX_RESULTS)]
