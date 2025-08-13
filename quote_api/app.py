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
from webdriver_manager.chrome import ChromeDriverManager


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
TIMEOUT = 4.0
MAX_WORKERS = int(os.cpu_count() or 1) * 2

# --- Exact methodology from original script ---


def _str_to_float(text: str) -> Optional[float]:
    """Parse price/change/percentage text to float - EXACT copy from original."""
    if not text or not text.strip():
        return None

    try:
        # Clean the text: remove currency symbols, parentheses, and extra spaces
        cleaned = re.sub(r"[$,()%\s]", "", text.strip())

        # Handle empty string after cleaning
        if not cleaned:
            return None

        # Convert to float
        return float(cleaned)
    except (ValueError, TypeError):
        logger.warning(f"Could not parse number: '{text}'")
        return None


def _get_chrome_options() -> Options:
    """Get optimized Chrome options - EXACT copy from original."""
    options = Options()

    # Performance args - EXACT from original
    args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-plugins", "--disable-images", "--disable-web-security", "--disable-features=VizDisplayCompositor", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-client-side-phishing-detection", "--disable-crash-reporter", "--disable-oopr-debug-crash-dump", "--no-crash-upload", "--disable-low-res-tiling", "--memory-pressure-off", "--window-size=1200,800"]
    for arg in args:
        options.add_argument(arg)

    # Disable content for speed - EXACT from original
    prefs = {
        "profile.managed_default_content_settings.images": 2,
        "profile.managed_default_content_settings.stylesheets": 2,
        "profile.managed_default_content_settings.fonts": 2,
        "profile.managed_default_content_settings.plugins": 2,
        "profile.managed_default_content_settings.popups": 2,
        "profile.managed_default_content_settings.notifications": 2,
        "profile.default_content_settings.popups": 0,
    }
    options.add_experimental_option("prefs", prefs)
    options.add_experimental_option("useAutomationExtension", False)
    options.add_experimental_option("excludeSwitches", ["enable-automation"])

    return options


def _setup_driver_performance(driver: webdriver.Chrome) -> None:
    """Setup performance optimizations for driver - EXACT copy from original."""
    try:
        # Block unnecessary resources
        blocked_urls = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.ico", "*.css", "*.woff*", "*.ttf", "*doubleclick*", "*analytics*", "*ads*", "*advertising*", "*.mp4", "*.mp3", "*tracking*"]
        driver.execute_cdp_cmd("Network.enable", {})
        driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": blocked_urls})
        driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"})
    except Exception:
        pass  # Ignore CDP errors


def _create_driver() -> webdriver.Chrome:
    """Create optimized Chrome driver - EXACT copy from original."""
    options = _get_chrome_options()

    # Fast page load strategy - EXACT from original
    caps = options.to_capabilities()
    caps["pageLoadStrategy"] = "none"

    # Use modern Selenium syntax - EXACT from original
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)

    _setup_driver_performance(driver)
    driver.implicitly_wait(0.5)

    return driver


@contextmanager
def _get_driver():
    """Context manager for driver lifecycle - EXACT copy from original."""
    driver = None
    try:
        driver = _create_driver()
        yield driver
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


def _extract_quote_data(driver: webdriver.Chrome, symbol: str) -> Optional[Quote]:
    """Extract quote data from Yahoo Finance page - EXACT copy from original."""
    try:
        # Navigate and wait for price element
        url = f"https://finance.yahoo.com/quote/{symbol}/"
        driver.get(url)

        wait = WebDriverWait(driver, TIMEOUT)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Get all quote elements at once
        elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        data = {elem.get_attribute("data-testid"): elem.text for elem in elements if elem.text}

        # Stop loading immediately - EXACT from original
        try:
            driver.execute_script("window.stop();")
        except Exception:
            pass

        # Extract and parse regular market data
        regular_price = _str_to_float(data.get("qsp-price"))
        regular_change = _str_to_float(data.get("qsp-price-change"))
        regular_change_percent = _str_to_float(data.get("qsp-price-change-percent"))

        # Extract and parse premarket/overnight/postmarket data - EXACT from original
        realtime_price = _str_to_float(data.get("qsp-pre-price") or data.get("qsp-overnight-price") or data.get("qsp-post-price"))
        realtime_change = _str_to_float(data.get("qsp-pre-price-change") or data.get("qsp-overnight-price-change") or data.get("qsp-post-price-change"))
        realtime_change_percent = _str_to_float(data.get("qsp-pre-price-change-percent") or data.get("qsp-overnight-price-change-percent") or data.get("qsp-post-price-change-percent"))

        return Quote(
            symbol=symbol,
            regular_price=regular_price,
            regular_change=regular_change,
            regular_change_percent=regular_change_percent,
            realtime_price=realtime_price,
            realtime_change=realtime_change,
            realtime_change_percent=realtime_change_percent,
        )

    except Exception as e:
        logger.error(f"Error extracting quote for {symbol}: {e}")
        return None


def _get_single_quote(symbol: str) -> Optional[Quote]:
    """Get quote for single symbol with own driver - EXACT copy from original."""
    with _get_driver() as driver:
        return _extract_quote_data(driver, symbol)


# --- FastAPI App ---

app = FastAPI(
    title="Stock Quote API - Original Methodology",
    description="An API using the exact methodology from the working original script.",
    version="4.0.0",
)


@app.get("/quote", response_model=Quote)
def get_quote_endpoint(symbol: str):
    """Fetches a quote for a single stock symbol."""
    quote = _get_single_quote(symbol.upper())
    if not quote:
        raise HTTPException(status_code=404, detail=f"Quote for symbol '{symbol}' not found.")
    return quote


@app.get("/quotes", response_model=List[Quote])
def get_quotes_endpoint(symbols: str):
    """
    Fetches quotes for a comma-separated list of stock symbols concurrently.
    Uses EXACT methodology from original script.
    """
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="No symbols provided.")

    max_workers = min(min(len(symbol_list), os.cpu_count() or 1), 16)  # Use original MAX_WORKERS logic
    results = [None] * len(symbol_list)

    # Use exact logic from original batch_get_quote
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit tasks
        future_to_symbol = {executor.submit(_get_single_quote, symbol): symbol for symbol in symbol_list}

        # Process results
        for future in as_completed(future_to_symbol):
            symbol = future_to_symbol[future]
            try:
                quote = future.result()
                if quote:
                    results[symbol_list.index(symbol)] = quote
            except Exception as e:
                logger.warning(f"Error fetching {symbol}: {e}")

    successful_quotes = [q for q in results if q is not None]
    if not successful_quotes:
        raise HTTPException(status_code=404, detail="Could not fetch any quotes for the provided symbols.")

    logger.info(f"Successfully fetched {len(successful_quotes)}/{len(symbol_list)} quotes.")
    return successful_quotes


@app.get("/")
def read_root():
    return {"message": "Stock Quote API - Original Methodology"}
