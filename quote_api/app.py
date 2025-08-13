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
from webdriver_manager.chrome import ChromeDriverManager

# --- Ultra-Low Resource Configuration ---
TIMEOUT = 2.0  # Reduced timeout for faster failures
MAX_WORKERS = 2  # Minimal concurrency to prevent resource spikes


# --- Pydantic Schema ---
class Quote(BaseModel):
    symbol: str
    regular_price: Optional[float] = None
    regular_change: Optional[float] = None
    regular_change_percent: Optional[float] = None
    realtime_price: Optional[float] = None
    realtime_change: Optional[float] = None
    realtime_change_percent: Optional[float] = None


# --- Ultra-Low Resource Functions ---


def _str_to_float(text: str) -> Optional[float]:
    """Parse price/change/percentage text to float."""
    if not text:
        return None
    try:
        cleaned = re.sub(r"[$,()%\s]", "", text.strip())
        return float(cleaned) if cleaned else None
    except:
        return None


def _get_ultra_low_chrome_options() -> Options:
    """Get Chrome options optimized for minimal CPU/RAM usage."""
    options = Options()

    # Core minimal flags
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")

    # Aggressive memory/CPU reduction
    options.add_argument("--memory-pressure-off")
    options.add_argument("--max_old_space_size=100")  # Limit memory to 100MB
    options.add_argument("--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess")
    options.add_argument("--disable-background-timer-throttling")
    options.add_argument("--disable-renderer-backgrounding")
    options.add_argument("--disable-backgrounding-occluded-windows")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-ipc-flooding-protection")

    # Disable everything possible
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-plugins")
    options.add_argument("--disable-images")
    options.add_argument("--disable-javascript")  # Disable JS for faster loading
    options.add_argument("--disable-web-security")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-popup-blocking")
    options.add_argument("--disable-translate")
    options.add_argument("--disable-sync")
    options.add_argument("--disable-logging")
    options.add_argument("--disable-permissions-api")
    options.add_argument("--disable-presentation-api")

    # Minimal window size
    options.add_argument("--window-size=800,600")

    # Ultra-aggressive content blocking
    prefs = {
        "profile.managed_default_content_settings.images": 2,
        "profile.managed_default_content_settings.stylesheets": 2,
        "profile.managed_default_content_settings.cookies": 2,
        "profile.managed_default_content_settings.javascript": 2,
        "profile.managed_default_content_settings.plugins": 2,
        "profile.managed_default_content_settings.popups": 2,
        "profile.managed_default_content_settings.geolocation": 2,
        "profile.managed_default_content_settings.notifications": 2,
        "profile.managed_default_content_settings.media_stream": 2,
    }
    options.add_experimental_option("prefs", prefs)
    options.add_experimental_option("useAutomationExtension", False)
    options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])

    return options


@contextmanager
def _get_minimal_driver():
    """Ultra-lightweight driver context manager."""
    driver = None
    try:
        options = _get_ultra_low_chrome_options()
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)
        driver.implicitly_wait(0.1)  # Minimal wait
        driver.set_page_load_timeout(TIMEOUT)  # Hard timeout
        yield driver
    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass


def _extract_quote_minimal(driver: webdriver.Chrome, symbol: str) -> Optional[Quote]:
    """Extract quote data with minimal processing."""
    try:
        driver.get(f"https://finance.yahoo.com/quote/{symbol}/")

        # Quick element detection
        wait = WebDriverWait(driver, TIMEOUT)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Fast element collection
        elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        data = {}
        for elem in elements:
            testid = elem.get_attribute("data-testid")
            text = elem.text
            if testid and text:
                data[testid] = text

        # Immediate stop to prevent further loading
        driver.execute_script("window.stop();")

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


def _get_single_quote_minimal(symbol: str) -> Optional[Quote]:
    """Get quote with minimal resource usage."""
    with _get_minimal_driver() as driver:
        return _extract_quote_minimal(driver, symbol)


# --- Ultra-Efficient FastAPI App ---

app = FastAPI(
    title="Ultra-Low Resource Stock API",
    description="Minimal CPU/RAM stock quote API",
    version="1.0.0",
)


@app.get("/quote", response_model=Quote)
def get_quote(symbol: str):
    """Get a single stock quote (ultra-low resource)."""
    quote = _get_single_quote_minimal(symbol.upper())
    if not quote:
        raise HTTPException(status_code=404, detail=f"Quote for '{symbol}' not found")
    return quote


@app.get("/quotes", response_model=List[Quote])
def get_quotes(symbols: str):
    """Get multiple quotes with minimal concurrency."""
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="No symbols provided")

    # Ultra-low concurrency to prevent resource spikes
    with ThreadPoolExecutor(max_workers=min(len(symbol_list), MAX_WORKERS)) as executor:
        future_to_symbol = {executor.submit(_get_single_quote_minimal, sym): sym for sym in symbol_list}
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
    return {"message": "⚡ Ultra-Low Resource Stock API", "description": "Minimal CPU/RAM stock quotes", "usage": {"single_quote": "https://realtime-stock-quote.up.railway.app/quote?symbol=AMD", "multiple_quotes": "https://realtime-stock-quote.up.railway.app/quotes?symbols=AMD,NVDA,PLTR"}, "docs": "/docs"}
