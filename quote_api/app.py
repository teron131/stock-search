import logging
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

# --- Simple Resource Configuration ---
MAX_WORKERS = 2  # Keep low concurrency to prevent resource spikes


# --- Pydantic Schema ---
class Quote(BaseModel):
    symbol: str
    regular_price: Optional[float] = None
    regular_change: Optional[float] = None
    regular_change_percent: Optional[float] = None
    realtime_price: Optional[float] = None
    realtime_change: Optional[float] = None
    realtime_change_percent: Optional[float] = None


# --- Natural Loading Functions ---


def _str_to_float(text: str) -> Optional[float]:
    """Parse price/change/percentage text to float."""
    if not text:
        return None
    try:
        cleaned = re.sub(r"[$,()%\s]", "", text.strip())
        return float(cleaned) if cleaned else None
    except:
        return None


def _get_optimized_chrome_options() -> Options:
    """Get Chrome options optimized for low resource usage."""
    options = Options()

    # Core minimal flags
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")

    # Memory/CPU reduction
    options.add_argument("--memory-pressure-off")
    options.add_argument("--max_old_space_size=200")  # 200MB memory limit
    options.add_argument("--disable-features=VizDisplayCompositor")
    options.add_argument("--disable-background-timer-throttling")
    options.add_argument("--disable-renderer-backgrounding")
    options.add_argument("--disable-backgrounding-occluded-windows")

    # Disable unnecessary features
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-plugins")
    options.add_argument("--disable-images")
    options.add_argument("--disable-web-security")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-translate")
    options.add_argument("--disable-sync")

    # Reasonable window size
    options.add_argument("--window-size=1000,700")

    # Content blocking for speed
    prefs = {
        "profile.managed_default_content_settings.images": 2,
        "profile.managed_default_content_settings.stylesheets": 2,
        "profile.managed_default_content_settings.plugins": 2,
        "profile.managed_default_content_settings.popups": 2,
        "profile.managed_default_content_settings.notifications": 2,
    }
    options.add_experimental_option("prefs", prefs)
    options.add_experimental_option("useAutomationExtension", False)
    options.add_experimental_option("excludeSwitches", ["enable-automation"])

    return options


@contextmanager
def _get_optimized_driver():
    """Driver context manager using system-installed ChromeDriver."""
    driver = None
    try:
        options = _get_optimized_chrome_options()
        # Use system-installed ChromeDriver
        service = Service("/usr/local/bin/chromedriver")
        driver = webdriver.Chrome(service=service, options=options)
        driver.implicitly_wait(0.5)
        yield driver
    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass


def _extract_quote_natural(driver: webdriver.Chrome, symbol: str) -> Optional[Quote]:
    """Extract quote data with natural page loading - no timeouts."""
    try:
        driver.get(f"https://finance.yahoo.com/quote/{symbol}/")

        # Wait for elements to load naturally (no timeout)
        wait = WebDriverWait(driver, float("inf"))  # Wait indefinitely
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Get all quote elements
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
    except:
        return None


def _get_single_quote_natural(symbol: str) -> Optional[Quote]:
    """Get quote with natural loading and resource limits."""
    with _get_optimized_driver() as driver:
        return _extract_quote_natural(driver, symbol)


# --- Reliable FastAPI App ---

app = FastAPI(
    title="Reliable Stock Quote API",
    description="Fast, reliable stock quotes with system ChromeDriver",
    version="1.0.0",
)


@app.get("/quote", response_model=Quote)
def get_quote(symbol: str):
    """Get a single stock quote."""
    quote = _get_single_quote_natural(symbol.upper())
    if not quote:
        raise HTTPException(status_code=404, detail=f"Quote for '{symbol}' not found")
    return quote


@app.get("/quotes", response_model=List[Quote])
def get_quotes(symbols: str):
    """Get multiple quotes with controlled concurrency."""
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="No symbols provided")

    # Low concurrency to prevent resource spikes
    with ThreadPoolExecutor(max_workers=min(len(symbol_list), MAX_WORKERS)) as executor:
        future_to_symbol = {executor.submit(_get_single_quote_natural, sym): sym for sym in symbol_list}
        results = []

        for future in as_completed(future_to_symbol):
            quote = future.result()
            if quote:
                results.append(quote)

    if not results:
        raise HTTPException(status_code=404, detail="No quotes found")

    return results


@app.get("/")
def root():
    """API information and usage examples."""
    return {"message": "🚀 Reliable Stock Quote API", "description": "Fast, reliable stock quotes with system ChromeDriver", "usage": {"single_quote": "https://realtime-stock-quote.up.railway.app/quote?symbol=AMD", "multiple_quotes": "https://realtime-stock-quote.up.railway.app/quotes?symbols=AMD,NVDA,PLTR"}, "docs": "/docs"}
