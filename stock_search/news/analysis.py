from concurrent.futures import ThreadPoolExecutor
import os

from docling.document_converter import DocumentConverter
from dotenv import load_dotenv
from langchain_core.prompts import PromptTemplate

from ..openrouter import ChatOpenRouter
from ..schema import News, NewsAnalysis

load_dotenv()

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-3-flash-preview")


def webloader_docling(urls: list[str]) -> list[str | None]:
    """Load and process website content from URLs into markdown."""
    converter = DocumentConverter()

    def _convert(url: str) -> str | None:
        try:
            return converter.convert(url).document.export_to_markdown()
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=min(len(urls), os.cpu_count())) as executor:
        return list(executor.map(_convert, urls))


def _analyze_news(ticker: str, news_list: list[News]) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs, preferring docling web loader."""
    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template="""Describe the news with details and numbers mentioned clearly and concretely.
No meta-language.
Exclude garbage and ads.
Set relevancy by how directly it impacts {ticker}:
- high = directly about {ticker} (earnings, guidance, major product, regulation)
- medium = same sector/competitors/macro with indirect impact
- low = general market noise; subjective analyst opinions without objective new facts
Relevancy rules:
- high only if {ticker} is the primary subject (headline + article focus)
- market wraps and broad sector commentary default to low unless {ticker} is a primary driver
Sentiment:
- bullish if clearly positive for {ticker}
- bearish if clearly negative
- neutral if mixed or unclear; insider selling is neutral unless unusually large, illegal, or clearly adverse
Subjective analysis/opinion defaults to neutral sentiment unless objective new facts clearly support a direction.
If the article text does not mention {ticker}, set relevancy to low, sentiment to neutral, and summary to a brief note that no relevant content was found.
Choose the best category for the primary focus:
- company_news: directly about the company
- earnings: financial results and guidance
- analyst_rating: changes in analyst coverage/targets
- industry_news: sector-wide news
- market_news: general stock market updates
- macro_economics: economic data and policy
- analysis: deep dives or opinion pieces
- other: anything else

{title}
{text}""",
        input_variables=["ticker", "title", "text"],
    )

    fallback = NewsAnalysis(summary="Content unavailable or invalid URL.")
    urls = [news.url for news in news_list]
    documents = webloader_docling(urls)
    results: list[NewsAnalysis] = [fallback] * len(news_list)
    prompts: list[str] = []
    prompt_indices: list[int] = []
    for idx, (news, article_text) in enumerate(zip(news_list, documents, strict=True)):
        if not article_text:
            continue

        prompts.append(
            prompt_template.format(
                ticker=ticker,
                title=news.title,
                text=article_text,
            )
        )
        prompt_indices.append(idx)

    if prompts:
        responses = llm.batch(prompts, config={"max_concurrency": len(prompts)})
        for idx, response in zip(prompt_indices, responses, strict=True):
            results[idx] = response

    return results


def process_articles(ticker: str, news_list: list[News]) -> list[News]:
    """Process articles by analyzing their URLs and applying LLM analysis."""
    if not news_list:
        return []

    return [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(
            news_list,
            _analyze_news(ticker, news_list),
            strict=True,
        )
    ]
