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

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
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


class HealthCheck(BaseModel):
    status: str
    chrome_version: Optional[str] = None
    error: Optional[str] = None


# --- Helper Functions ---


def _str_to_float(text: str) -> Optional[float]:
    """Parse price/change/percentage text to float."""
    if not text:
        return None
    try:
        cleaned = re.sub(r"[$,()%\s]", "", text.strip())
        return float(cleaned) if cleaned else None
    except Exception as e:
        logger.warning(f"Failed to parse '{text}' to float: {e}")
        return None


def _get_optimized_chrome_options() -> Options:
    """Get Chrome options optimized for low resource usage."""
    options = Options()

    # Core minimal flags
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")

    # Memory/CPU reduction
    options.add_argument("--memory-pressure-off")
    options.add_argument("--max_old_space_size=200")  # 200MB memory limit
    options.add_argument("--disable-features=VizDisplayCompositor")
    options.add_argument("--disable-background-timer-throttling")
    options.add_argument("--disable-renderer-backgrounding")
    options.add_argument("--disable-backgrounding-occluded-windows")

    # Disable unnecessary features
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-plugins")
    options.add_argument("--disable-images")
    options.add_argument("--disable-web-security")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-translate")
    options.add_argument("--disable-sync")

    # Container-specific options
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-default-apps")
    options.add_argument("--disable-sync")
    options.add_argument("--metrics-recording-only")
    options.add_argument("--no-first-run")
    options.add_argument("--safebrowsing-disable-auto-update")
    options.add_argument("--disable-ipc-flooding-protection")

    # Window size
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


def _create_driver() -> webdriver.Chrome:
    """Create Chrome WebDriver using a matching driver for installed Chrome."""
    try:
        options = _get_optimized_chrome_options()
        # Use webdriver-manager to install the correct ChromeDriver version
        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)
        driver.implicitly_wait(0.5)
        logger.info("ChromeDriver created successfully")
        return driver
    except Exception as e:
        logger.error(f"Failed to create ChromeDriver: {e}")
        raise


@contextmanager
def _get_reliable_driver():
    """Reliable driver context manager."""
    driver = None
    try:
        driver = _create_driver()
        yield driver
    except Exception as e:
        logger.error(f"Driver context manager error: {e}")
        raise
    finally:
        if driver:
            try:
                driver.quit()
                logger.info("ChromeDriver closed successfully")
            except Exception as e:
                logger.warning(f"Error closing driver: {e}")


def _extract_quote_reliable(driver: webdriver.Chrome, symbol: str) -> Optional[Quote]:
    """Extract quote data with natural page loading."""
    try:
        logger.info(f"Fetching quote for symbol: {symbol}")
        driver.get(f"https://finance.yahoo.com/quote/{symbol}/")

        # Wait for elements to load naturally
        wait = WebDriverWait(driver, 15)  # 15 second timeout
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Get all quote elements
        elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        data = {elem.get_attribute("data-testid"): elem.text for elem in elements if elem.text}

        logger.info(f"Found {len(data)} data elements for {symbol}")

        quote = Quote(
            symbol=symbol,
            regular_price=_str_to_float(data.get("qsp-price")),
            regular_change=_str_to_float(data.get("qsp-price-change")),
            regular_change_percent=_str_to_float(data.get("qsp-price-change-percent")),
            realtime_price=_str_to_float(data.get("qsp-pre-price") or data.get("qsp-post-price")),
            realtime_change=_str_to_float(data.get("qsp-pre-price-change") or data.get("qsp-post-price-change")),
            realtime_change_percent=_str_to_float(data.get("qsp-pre-price-change-percent") or data.get("qsp-post-price-change-percent")),
        )

        logger.info(f"Successfully extracted quote for {symbol}: ${quote.regular_price}")
        return quote
    except Exception as e:
        logger.error(f"Failed to extract quote for {symbol}: {e}")
        return None


def _get_single_quote_reliable(symbol: str) -> Optional[Quote]:
    """Get quote with reliable driver and resource limits."""
    try:
        with _get_reliable_driver() as driver:
            return _extract_quote_reliable(driver, symbol)
    except Exception as e:
        logger.error(f"Failed to get quote for {symbol}: {e}")
        return None


# --- FastAPI App ---

app = FastAPI(
    title="Stock Quote API",
    description="Real-time stock quotes using system-installed Chrome",
    version="1.0.0",
)


@app.get("/health", response_model=HealthCheck)
def health_check():
    """Health check endpoint to verify Chrome and WebDriver availability."""
    import subprocess

    health = HealthCheck(status="unknown")

    try:
        # Try to get Chrome version
        try:
            result = subprocess.run(["google-chrome", "--version"], capture_output=True, text=True, timeout=5)
            health.chrome_version = result.stdout.strip()
        except Exception as e:
            health.chrome_version = f"Could not determine version: {e}"

        # Attempt to create a driver
        with _get_reliable_driver() as driver:
            health.status = "healthy"

    except Exception as e:
        health.status = "error"
        health.error = str(e)

    return health


@app.get("/quote", response_model=Quote)
def get_quote(symbol: str):
    """Get a single stock quote."""
    logger.info(f"Received request for single quote: {symbol}")
    quote = _get_single_quote_reliable(symbol.upper())
    if not quote:
        raise HTTPException(status_code=404, detail=f"Quote for '{symbol}' not found")
    return quote


@app.get("/quotes", response_model=List[Quote])
def get_quotes(symbols: str):
    """Get multiple quotes with controlled concurrency."""
    logger.info(f"Received request for multiple quotes: {symbols}")
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not symbol_list:
        raise HTTPException(status_code=400, detail="No symbols provided")

    # Low concurrency to prevent resource spikes
    with ThreadPoolExecutor(max_workers=min(len(symbol_list), MAX_WORKERS)) as executor:
        future_to_symbol = {executor.submit(_get_single_quote_reliable, sym): sym for sym in symbol_list}
        results = []

        for future in as_completed(future_to_symbol):
            quote = future.result()
            if quote:
                results.append(quote)

    if not results:
        raise HTTPException(status_code=404, detail="No quotes found")

    logger.info(f"Returning {len(results)} quotes")
    return results


@app.get("/")
def root():
    """API information and usage examples."""
    return {"message": "🚀 Stock Quote API", "description": "Real-time stock quotes using system-installed Chrome", "usage": {"health_check": "/health", "single_quote": "/quote?symbol=AMD", "multiple_quotes": "/quotes?symbols=AMD,NVDA,PLTR"}, "docs": "/docs"}
