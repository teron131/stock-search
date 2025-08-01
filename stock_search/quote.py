import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from typing import List, Optional

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from tqdm import tqdm
from webdriver_manager.chrome import ChromeDriverManager

from stock_search.schema import Quote

# Constants
DEFAULT_TIMEOUT = 4.0
IMPLICIT_WAIT = 0.5
MAX_WORKERS_LIMIT = 16
WINDOW_SIZE = "1200,800"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Blocked URLs for performance
BLOCKED_URLS = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.ico", "*.css", "*.woff", "*.woff2", "*.ttf", "*.otf", "*doubleclick*", "*googlesyndication*", "*analytics*", "*gtag*", "*facebook*", "*twitter*", "*linkedin*", "*pinterest*", "*ads*", "*ad.*", "*advertising*", "*metrics*", "*chartbeat*", "*optimizely*", "*hotjar*", "*mixpanel*", "*.mp4", "*.webm", "*.ogg", "*.mp3", "*.wav", "*cdn.jsdelivr*", "*cdnjs*", "*unpkg*", "*bootstrap*", "*jquery*", "*tracking*"]

# CSS Selectors
PRICE_SELECTOR = "[data-testid='qsp-price']"
CHANGE_SELECTOR = "[data-testid='qsp-price-change']"
CHANGE_PERCENT_SELECTOR = "[data-testid='qsp-price-change-percent']"
QSP_SELECTOR = "[data-testid^='qsp-']"

# Content settings for Chrome
CONTENT_SETTINGS = {
    "profile.managed_default_content_settings.images": 2,
    "profile.managed_default_content_settings.stylesheets": 2,
    "profile.managed_default_content_settings.fonts": 2,
    "profile.managed_default_content_settings.plugins": 2,
    "profile.managed_default_content_settings.popups": 2,
    "profile.managed_default_content_settings.geolocation": 2,
    "profile.managed_default_content_settings.notifications": 2,
    "profile.managed_default_content_settings.media_stream": 2,
    "profile.managed_default_content_settings.cookies": 2,
    "profile.default_content_setting_values.notifications": 2,
    "profile.default_content_settings.popups": 0,
}

# Setup logging
logger = logging.getLogger(__name__)


class DriverManager:
    """Manages Chrome WebDriver instances with optimized settings."""

    def __init__(self):
        self._service = None

    def _get_service(self) -> Service:
        """Get or create Chrome service instance."""
        if self._service is None:
            self._service = Service(ChromeDriverManager().install())
        return self._service

    def _create_chrome_options(self) -> Options:
        """Create optimized Chrome options for maximum speed."""
        chrome_options = Options()

        # Performance arguments
        performance_args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--disable-plugins", "--disable-images", "--disable-web-security", "--disable-features=VizDisplayCompositor", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-client-side-phishing-detection", "--disable-crash-reporter", "--disable-oopr-debug-crash-dump", "--no-crash-upload", "--disable-low-res-tiling", "--memory-pressure-off", f"--window-size={WINDOW_SIZE}"]

        for arg in performance_args:
            chrome_options.add_argument(arg)

        # Experimental options
        chrome_options.add_experimental_option("prefs", CONTENT_SETTINGS)
        chrome_options.add_experimental_option("useAutomationExtension", False)
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])

        # Page load strategy
        caps = chrome_options.to_capabilities()
        caps["pageLoadStrategy"] = "none"

        return chrome_options

    def create_driver(self) -> webdriver.Chrome:
        """Create a new Chrome WebDriver instance with optimized settings."""
        try:
            chrome_options = self._create_chrome_options()
            driver = webdriver.Chrome(
                service=self._get_service(),
                options=chrome_options,
            )

            # Configure network blocking and optimizations
            self._configure_driver_network(driver)
            driver.implicitly_wait(IMPLICIT_WAIT)

            return driver

        except Exception as e:
            logger.error(f"Failed to create Chrome driver: {e}")
            raise WebDriverException(f"Could not initialize Chrome driver: {e}")

    def _configure_driver_network(self, driver: webdriver.Chrome) -> None:
        """Configure network settings for the driver."""
        try:
            # Enable network domain
            driver.execute_cdp_cmd("Network.enable", {})

            # Block unnecessary resources
            driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": BLOCKED_URLS})

            # Set user agent
            driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": USER_AGENT})

            # Enable runtime for performance optimizations
            driver.execute_cdp_cmd("Runtime.enable", {})
            driver.execute_cdp_cmd("Runtime.addBinding", {"name": "stopLoading"})

        except Exception as e:
            logger.warning(f"Failed to configure network settings: {e}")


# Global driver manager instance
_driver_manager = DriverManager()


@contextmanager
def get_driver():
    """Context manager for Chrome WebDriver instances."""
    driver = None
    try:
        driver = _driver_manager.create_driver()
        yield driver
    finally:
        if driver:
            try:
                driver.quit()
            except Exception as e:
                logger.warning(f"Error closing driver: {e}")


def _extract_quote_data(driver: webdriver.Chrome, symbol: str) -> Optional[Quote]:
    """Extract quote data from Yahoo Finance page."""
    try:
        # Wait for main price element
        wait = WebDriverWait(driver, DEFAULT_TIMEOUT)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, PRICE_SELECTOR)))

        # Batch find all quote-related elements
        elements = driver.find_elements(By.CSS_SELECTOR, QSP_SELECTOR)
        element_dict = {elem.get_attribute("data-testid"): elem for elem in elements}

        # Extract regular market data
        regular_price = element_dict.get("qsp-price")
        regular_change = element_dict.get("qsp-price-change")
        regular_change_percent = element_dict.get("qsp-price-change-percent")

        # Extract premarket/overnight data
        realtime_price_elem = element_dict.get("qsp-pre-price") or element_dict.get("qsp-overnight-price")
        realtime_change_elem = element_dict.get("qsp-pre-price-change") or element_dict.get("qsp-overnight-price-change")
        realtime_change_percent_elem = element_dict.get("qsp-pre-price-change-percent") or element_dict.get("qsp-overnight-price-change-percent")

        # Stop page loading to save resources
        try:
            driver.execute_script("window.stop();")
        except Exception:
            pass  # Ignore if script execution fails

        return Quote(
            regular_price=regular_price.text if regular_price else None,
            regular_change=regular_change.text if regular_change else None,
            regular_change_percent=re.sub(r"[()]+", "", regular_change_percent.text) if regular_change_percent else None,
            realtime_price=realtime_price_elem.text if realtime_price_elem else None,
            realtime_change=realtime_change_elem.text if realtime_change_elem else None,
            realtime_change_percent=re.sub(r"[()]+", "", realtime_change_percent_elem.text) if realtime_change_percent_elem else None,
        )

    except TimeoutException:
        logger.error(f"Timeout waiting for price data for symbol: {symbol}")
        return None
    except Exception as e:
        logger.error(f"Error extracting quote data for {symbol}: {e}")
        return None


def _get_quote_with_driver(symbol: str, driver: webdriver.Chrome) -> Optional[Quote]:
    """Get quote using a specific driver instance."""
    try:
        url = f"https://finance.yahoo.com/quote/{symbol}/"
        driver.get(url)
        return _extract_quote_data(driver, symbol)

    except Exception as e:
        logger.error(f"Error fetching quote for {symbol}: {e}")
        return None


def get_quote(symbol: str) -> Optional[Quote]:
    """Get the price and change (including premarket and overnight) for a given symbol from Yahoo Finance."""
    with get_driver() as driver:
        return _get_quote_with_driver(symbol, driver)


def _get_single_quote_with_own_driver(symbol: str) -> Optional[Quote]:
    """Get quote for a single symbol using its own driver instance (for concurrent use)."""
    with get_driver() as driver:
        return _get_quote_with_driver(symbol, driver)


def batch_get_quote(symbols: List[str], max_retries: int = 3, max_workers: Optional[int] = None) -> List[Optional[Quote]]:
    """Get quotes for multiple symbols concurrently with retry mechanism.

    Args:
        symbols: List of stock symbols to fetch quotes for
        max_retries: Maximum number of retry attempts for failed quotes
        max_workers: Maximum number of concurrent workers (auto-calculated if None)

    Returns:
        List of Quote objects (may contain None for quotes that failed all retries)
    """
    if not symbols:
        return []

    # Calculate optimal number of workers
    if max_workers is None:
        max_workers = min(len(symbols), os.cpu_count() or 4, MAX_WORKERS_LIMIT)

    results: List[Optional[Quote]] = [None] * len(symbols)
    symbol_to_index = {symbol: i for i, symbol in enumerate(symbols)}

    for attempt in range(max_retries + 1):
        # Find symbols that still need to be fetched
        failed_symbols = [symbols[i] for i, result in enumerate(results) if result is None]

        if not failed_symbols:
            break  # All symbols successfully fetched

        logger.info(f"Attempt {attempt + 1}/{max_retries + 1}: Fetching {len(failed_symbols)} symbols")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit tasks and track futures
            future_to_symbol = {executor.submit(_get_single_quote_with_own_driver, symbol): symbol for symbol in failed_symbols}

            # Process completed futures with progress bar
            for future in tqdm(as_completed(future_to_symbol), total=len(failed_symbols), desc=f"Fetching quotes (attempt {attempt + 1})"):
                symbol = future_to_symbol[future]
                try:
                    quote = future.result()
                    if quote is not None:
                        results[symbol_to_index[symbol]] = quote
                except Exception as e:
                    logger.error(f"Error processing future for {symbol}: {e}")

    # Log final statistics
    successful_count = sum(1 for result in results if result is not None)
    logger.info(f"Successfully fetched {successful_count}/{len(symbols)} quotes")

    return results


# Legacy Robinhood implementation (commented out)
# def get_quote_robinhood(symbol: str) -> tuple[str, str]:
#     """Get the price and change (including premarket and postmarket) for a given symbol."""
#     instrument_id = requests.get(f"https://api.robinhood.com/quotes/{symbol}/").json()["instrument_id"]
#     bonfire = requests.get(f"https://bonfire.robinhood.com/instruments/{instrument_id}/detail-page-live-updating-data/?display_span=day&hide_extended_hours=false").json()
#     price = bonfire["chart_section"]["default_display"]["primary_value"]["value"]
#     change = bonfire["chart_section"]["default_display"]["secondary_value"]["main"]["value"]
#     return price, change
