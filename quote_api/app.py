import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


# --- Pydantic Schema ---
class Quote(BaseModel):
    symbol: str
    regular_price: Optional[float] = None
    regular_change: Optional[float] = None
    regular_change_percent: Optional[float] = None
    realtime_price: Optional[float] = None
    realtime_change: Optional[float] = None
    realtime_change_percent: Optional[float] = None


# --- Configuration ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
TIMEOUT = 5.0
MAX_WORKERS = int(os.cpu_count() or 1) * 2


# --- Web Driver Manager (Singleton) ---
class DriverManager:
    _driver: Optional[webdriver.Chrome] = None

    @classmethod
    def get_driver(cls) -> webdriver.Chrome:
        if cls._driver is None:
            logger.info("Initializing new Chrome driver instance with performance optimizations...")
            options = Options()
            options.binary_location = "/usr/bin/google-chrome-stable"

            # Use the comprehensive, optimized arguments from the original script
            args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-plugins", "--disable-images", "--disable-web-security", "--disable-features=VizDisplayCompositor", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-client-side-phishing-detection", "--disable-crash-reporter", "--disable-oopr-debug-crash-dump", "--no-crash-upload", "--disable-low-res-tiling", "--memory-pressure-off", "--window-size=1200,800"]
            for arg in args:
                options.add_argument(arg)

            # Disable content for speed
            prefs = {
                "profile.managed_default_content_settings.images": 2,
                "profile.managed_default_content_settings.stylesheets": 2,
                "profile.managed_default_content_settings.fonts": 2,
            }
            options.add_experimental_option("prefs", prefs)

            service = Service()
            cls._driver = webdriver.Chrome(service=service, options=options)
            logger.info("Optimized Chrome driver initialized.")
        return cls._driver

    @classmethod
    def close_driver(cls):
        if cls._driver:
            logger.info("Closing Chrome driver instance.")
            cls._driver.quit()
            cls._driver = None


# --- FastAPI App ---
app = FastAPI(
    title="Optimized Stock Quote API",
    description="An efficient API to fetch stock quotes using a persistent Selenium driver.",
    version="2.0.0",
)


@app.on_event("startup")
async def startup_event():
    """Initialize the WebDriver on application startup."""
    DriverManager.get_driver()


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanly close the WebDriver on application shutdown."""
    DriverManager.close_driver()


# --- Web Scraping Logic ---


def _str_to_float(text: str) -> Optional[float]:
    if not text or not text.strip():
        return None
    try:
        cleaned = re.sub(r"[$,()%\s]", "", text.strip())
        return float(cleaned) if cleaned else None
    except (ValueError, TypeError):
        logger.warning(f"Could not parse number: '{text}'")
        return None


def _extract_quote_data(symbol: str) -> Optional[Quote]:
    """Extracts quote data using the shared driver instance."""
    driver = DriverManager.get_driver()
    try:
        url = f"https://finance.yahoo.com/quote/{symbol}/"
        driver.get(url)
        # Use a more reliable wait condition
        wait = WebDriverWait(driver, TIMEOUT)
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        data = {elem.get_attribute("data-testid"): elem.text for elem in elements if elem.text}

        return Quote(
            symbol=symbol,
            regular_price=_str_to_float(data.get("qsp-price")),
            regular_change=_str_to_float(data.get("qsp-price-change")),
            regular_change_percent=_str_to_float(data.get("qsp-price-change-percent")),
            realtime_price=_str_to_float(data.get("qsp-pre-price") or data.get("qsp-post-price")),
            realtime_change=_str_to_float(data.get("qsp-pre-price-change") or data.get("qsp-post-price-change")),
            realtime_change_percent=_str_to_float(data.get("qsp-pre-price-change-percent") or data.get("qsp-post-price-change-percent")),
        )
    except Exception as e:
        logger.error(f"Error extracting quote for {symbol}: {e}")
        # In case of error, refresh the page to prevent a stuck state
        driver.refresh()
        return None


# --- API Endpoints ---


@app.get("/quote", response_model=Quote)
def get_quote_endpoint(symbol: str):
    """Fetches a quote for a single stock symbol."""
    quote = _extract_quote_data(symbol.upper())
    if not quote:
        raise HTTPException(status_code=404, detail=f"Quote for symbol '{symbol}' not found.")
    return quote


@app.get("/quotes", response_model=List[Quote])
def get_quotes_endpoint(symbols: str):
    """
    Fetches quotes for a comma-separated list of stock symbols.
    Example: `?symbols=AAPL,GOOG,MSFT`
    """
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="No symbols provided.")

    quotes: List[Optional[Quote]] = [None] * len(symbol_list)
    with ThreadPoolExecutor(max_workers=min(len(symbol_list), MAX_WORKERS)) as executor:
        future_to_symbol = {executor.submit(_extract_quote_data, sym): sym for sym in symbol_list}

        logger.info(f"Fetching {len(symbol_list)} quotes concurrently...")
        for future in as_completed(future_to_symbol):
            result = future.result()
            if result:
                idx = symbol_list.index(result.symbol)
                quotes[idx] = result

    successful_quotes = [q for q in quotes if q is not None]
    if not successful_quotes:
        raise HTTPException(status_code=404, detail="Could not fetch any quotes for the provided symbols.")

    logger.info(f"Successfully fetched {len(successful_quotes)}/{len(symbol_list)} quotes.")
    return successful_quotes


@app.get("/")
def read_root():
    return {"message": "Welcome to the Optimized Stock Quote API"}
