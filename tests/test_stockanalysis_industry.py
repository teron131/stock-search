from selectolax.lexbor import LexborHTMLParser

from stock_search.data_sources.stockanalysis.page_scrapers.industry import (
    STOCKANALYSIS_INDUSTRY_ALL_URL,
    STOCKANALYSIS_INDUSTRY_URL,
    scrape_industry_snapshot,
)


def test_scrape_industry_snapshot_merges_monthly_change_by_industry_slug() -> None:
    grouped_html = """
    <html>
      <body>
        <h2>Sector: Healthcare</h2>
        <table>
          <tbody>
            <tr>
              <td><a href="/stocks/industry/biotechnology/">Biotechnology</a></td>
              <td>590</td>
              <td>1.17T</td>
              <td>0.04%</td>
              <td>-</td>
              <td>-36.04%</td>
              <td>-0.68%</td>
              <td>148.46%</td>
            </tr>
            <tr>
              <td><a href="/stocks/industry/medical-devices/">Medical Devices</a></td>
              <td>139</td>
              <td>823.81B</td>
              <td>0.36%</td>
              <td>36.70</td>
              <td>15.86%</td>
              <td>0.73%</td>
              <td>31.21%</td>
            </tr>
          </tbody>
        </table>
        <h2>Sector: Financials</h2>
        <table>
          <tbody>
            <tr>
              <td><a href="/stocks/industry/banks-regional/">Banks - Regional</a></td>
              <td>324</td>
              <td>1.95T</td>
              <td>2.10%</td>
              <td>13.41</td>
              <td>27.51%</td>
              <td>-0.52%</td>
              <td>45.12%</td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
    """
    all_html = """
    <html>
      <body>
        <table>
          <tbody>
            <tr><td><a href="/stocks/industry/biotechnology/">Biotechnology</a></td></tr>
            <tr><td><a href="/stocks/industry/banks-regional/">Banks - Regional</a></td></tr>
            <tr><td><a href="/stocks/industry/medical-devices/">Medical Devices</a></td></tr>
          </tbody>
        </table>
      </body>
    </html>
    """

    def fetch_soup(url: str) -> LexborHTMLParser:
        if url == STOCKANALYSIS_INDUSTRY_URL:
            return LexborHTMLParser(grouped_html)
        if url == STOCKANALYSIS_INDUSTRY_ALL_URL:
            return LexborHTMLParser(all_html)
        raise AssertionError(f"unexpected url {url}")

    snapshot = scrape_industry_snapshot(
        fetch_soup=fetch_soup,
        fetch_aggregation_rows=lambda _table_id, _columns: [
            {"ch1m": 10.84, "grossMargin": 46.01},
            {"ch1m": 4.56, "grossMargin": 99.61},
            {"ch1m": 9.91, "grossMargin": 57.86},
        ],
    )

    assert len(snapshot.industries) == 3
    assert snapshot.industries[0].industry == "Biotechnology"
    assert snapshot.industries[0].change_percent_1m == 10.84
    assert snapshot.industries[0].gross_margin == 46.01
    assert snapshot.industries[1].industry == "Medical Devices"
    assert snapshot.industries[1].change_percent_1m == 9.91
    assert snapshot.industries[1].gross_margin == 57.86
    assert snapshot.industries[2].industry == "Banks - Regional"
    assert snapshot.industries[2].change_percent_1m == 4.56
    assert snapshot.industries[2].gross_margin == 99.61
