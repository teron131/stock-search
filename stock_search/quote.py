import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from typing import Dict, List, Optional

from rich import print
from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from tqdm import tqdm
from webdriver_manager.chrome import ChromeDriverManager

from stock_search.schema import Quote

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# Constants
TIMEOUT = 4.0
MAX_WORKERS = 16


def _get_chrome_options() -> Options:
    """Get optimized Chrome options."""
    options = Options()

    # Performance args
    args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-plugins", "--disable-images", "--disable-web-security", "--disable-features=VizDisplayCompositor", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-client-side-phishing-detection", "--disable-crash-reporter", "--disable-oopr-debug-crash-dump", "--no-crash-upload", "--disable-low-res-tiling", "--memory-pressure-off", "--window-size=1200,800"]
    for arg in args:
        options.add_argument(arg)

    # Disable content for speed
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
    """Setup performance optimizations for driver."""
    try:
        # Block unnecessary resources
        blocked_urls = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.ico", "*.css", "*.woff*", "*.ttf", "*doubleclick*", "*analytics*", "*ads*", "*advertising*", "*.mp4", "*.mp3", "*tracking*"]
        driver.execute_cdp_cmd("Network.enable", {})
        driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": blocked_urls})
        driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"})
    except Exception:
        pass  # Ignore CDP errors


def _create_driver() -> webdriver.Chrome:
    """Create optimized Chrome driver."""
    options = _get_chrome_options()

    # Fast page load strategy
    caps = options.to_capabilities()
    caps["pageLoadStrategy"] = "none"

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)

    _setup_driver_performance(driver)
    driver.implicitly_wait(0.5)

    return driver


@contextmanager
def _get_driver():
    """Context manager for driver lifecycle."""
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
    """Extract quote data from Yahoo Finance page."""
    try:
        # Navigate and wait for price element
        url = f"https://finance.yahoo.com/quote/{symbol}/"
        driver.get(url)

        wait = WebDriverWait(driver, TIMEOUT)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Get all quote elements at once
        elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        data = {elem.get_attribute("data-testid"): elem.text for elem in elements if elem.text}

        # Stop loading immediately
        try:
            driver.execute_script("window.stop();")
        except Exception:
            pass

        # Extract regular market data
        regular_price = data.get("qsp-price")
        regular_change = data.get("qsp-price-change")
        regular_change_percent = data.get("qsp-price-change-percent")
        if regular_change_percent:
            regular_change_percent = re.sub(r"[()]+", "", regular_change_percent)

        # Extract premarket/overnight data
        realtime_price = data.get("qsp-pre-price") or data.get("qsp-overnight-price") or data.get("qsp-post-price")
        realtime_change = data.get("qsp-pre-price-change") or data.get("qsp-overnight-price-change") or data.get("qsp-post-price-change")
        realtime_change_percent = data.get("qsp-pre-price-change-percent") or data.get("qsp-overnight-price-change-percent") or data.get("qsp-post-price-change-percent")
        if realtime_change_percent:
            realtime_change_percent = re.sub(r"[()]+", "", realtime_change_percent)

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
    """Get quote for single symbol with own driver."""
    with _get_driver() as driver:
        return _extract_quote_data(driver, symbol)


# Global driver for reuse
_global_driver = None


def get_driver() -> webdriver.Chrome:
    """Get or create global driver instance."""
    global _global_driver
    if _global_driver is None:
        _global_driver = _create_driver()
    return _global_driver


def close_driver() -> None:
    """Close global driver instance."""
    global _global_driver
    if _global_driver:
        try:
            _global_driver.quit()
        except Exception:
            pass
        finally:
            _global_driver = None


def get_quote(symbol: str) -> Optional[Quote]:
    """Get quote for single symbol using global driver."""
    return _extract_quote_data(get_driver(), symbol)


def batch_get_quote(symbols: List[str], max_retries: int = 3) -> List[Optional[Quote]]:
    """Get quotes for multiple symbols concurrently with retry mechanism."""
    if not symbols:
        return []

    max_workers = min(min(len(symbols), os.cpu_count()), MAX_WORKERS)
    results = [None] * len(symbols)

    for attempt in range(max_retries + 1):
        # Find symbols that still need fetching
        pending_symbols = [symbols[i] for i, result in enumerate(results) if result is None]

        if not pending_symbols:
            break

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit tasks
            future_to_symbol = {executor.submit(_get_single_quote, symbol): symbol for symbol in pending_symbols}

            # Process results with progress bar
            for future in tqdm(as_completed(future_to_symbol), total=len(pending_symbols), desc=f"Fetching quotes (attempt {attempt + 1})"):
                symbol = future_to_symbol[future]
                try:
                    quote = future.result()
                    if quote:
                        results[symbols.index(symbol)] = quote
                except Exception as e:
                    logger.warning(f"Error fetching {symbol}: {e}")

    successful = sum(1 for r in results if r is not None)
    print(f"✅ Successfully fetched {successful}/{len(symbols)} quotes")

    return results
