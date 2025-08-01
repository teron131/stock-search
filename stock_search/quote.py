import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from typing import Generator, List, Optional

from rich import print
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from tqdm import tqdm
from webdriver_manager.chrome import ChromeDriverManager

from stock_search.schema import Quote


def _create_optimized_chrome_options() -> Options:
    """Create optimized Chrome options for fast, headless scraping."""
    chrome_options = Options()

    # Essential performance options
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--disable-extensions")
    chrome_options.add_argument("--disable-images")
    chrome_options.add_argument("--disable-web-security")
    chrome_options.add_argument("--disable-features=VizDisplayCompositor")
    chrome_options.add_argument("--disable-background-timer-throttling")
    chrome_options.add_argument("--disable-renderer-backgrounding")
    chrome_options.add_argument("--disable-backgrounding-occluded-windows")
    chrome_options.add_argument("--disable-client-side-phishing-detection")
    chrome_options.add_argument("--disable-crash-reporter")
    chrome_options.add_argument("--memory-pressure-off")
    chrome_options.add_argument("--window-size=1200,800")

    # Content blocking preferences
    prefs = {
        "profile.managed_default_content_settings.images": 2,
        "profile.managed_default_content_settings.stylesheets": 2,
        "profile.managed_default_content_settings.plugins": 2,
        "profile.managed_default_content_settings.popups": 2,
        "profile.managed_default_content_settings.geolocation": 2,
        "profile.managed_default_content_settings.notifications": 2,
        "profile.managed_default_content_settings.media_stream": 2,
        "profile.default_content_settings.popups": 0,
    }
    chrome_options.add_experimental_option("prefs", prefs)
    chrome_options.add_experimental_option("useAutomationExtension", False)
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])

    return chrome_options


def _configure_driver_performance(driver: webdriver.Chrome) -> None:
    """Configure driver for optimal performance."""
    driver.execute_cdp_cmd("Network.enable", {})

    # Block unnecessary resources
    blocked_urls = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.ico", "*.css", "*.woff", "*.woff2", "*.ttf", "*.otf", "*.mp4", "*.webm", "*.ogg", "*.mp3", "*.wav", "*doubleclick*", "*googlesyndication*", "*analytics*", "*gtag*", "*facebook*", "*twitter*", "*linkedin*", "*pinterest*", "*ads*", "*ad.*", "*advertising*", "*metrics*", "*chartbeat*", "*optimizely*", "*hotjar*", "*mixpanel*", "*cdn.jsdelivr*", "*cdnjs*", "*unpkg*", "*bootstrap*", "*jquery*", "*tracking*"]
    driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": blocked_urls})

    # Set user agent
    user_agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": user_agent})

    driver.implicitly_wait(0.5)


@contextmanager
def get_driver() -> Generator[webdriver.Chrome, None, None]:
    """Context manager for Chrome driver with proper resource cleanup."""
    driver = None
    try:
        chrome_options = _create_optimized_chrome_options()

        # Set page load strategy for fastest loading
        caps = chrome_options.to_capabilities()
        caps["pageLoadStrategy"] = "none"

        service = Service(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=chrome_options)

        _configure_driver_performance(driver)

        yield driver

    except Exception as e:
        raise Exception(f"Failed to initialize Chrome driver: {e}")
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


def _extract_quote_data(driver: webdriver.Chrome, symbol: str) -> Quote:
    """Extract quote data from the loaded Yahoo Finance page."""
    # Wait for main price element
    wait = WebDriverWait(driver, 4.0)
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

    # Get all quote-related elements in one batch
    elements = driver.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
    element_dict = {elem.get_attribute("data-testid"): elem for elem in elements}

    # Extract regular market data
    regular_price = element_dict.get("qsp-price")
    regular_change = element_dict.get("qsp-price-change")
    regular_change_percent = element_dict.get("qsp-price-change-percent")

    # Extract premarket/overnight data
    realtime_price_elem = element_dict.get("qsp-pre-price") or element_dict.get("qsp-overnight-price")
    realtime_change_elem = element_dict.get("qsp-pre-price-change") or element_dict.get("qsp-overnight-price-change")
    realtime_change_percent_elem = element_dict.get("qsp-pre-price-change-percent") or element_dict.get("qsp-overnight-price-change-percent")

    # Stop page loading after getting data
    try:
        driver.execute_script("window.stop();")
    except Exception:
        pass

    # Clean percentage values by removing parentheses
    def clean_percentage(elem) -> Optional[str]:
        if elem and elem.text:
            return re.sub(r"[()]+", "", elem.text)
        return None

    return Quote(
        regular_price=regular_price.text if regular_price else None,
        regular_change=regular_change.text if regular_change else None,
        regular_change_percent=clean_percentage(regular_change_percent),
        realtime_price=realtime_price_elem.text if realtime_price_elem else None,
        realtime_change=realtime_change_elem.text if realtime_change_elem else None,
        realtime_change_percent=clean_percentage(realtime_change_percent_elem),
    )


def get_quote(symbol: str) -> Optional[Quote]:
    """Get the price and change data for a single symbol from Yahoo Finance."""
    try:
        with get_driver() as driver:
            url = f"https://finance.yahoo.com/quote/{symbol}/"
            driver.get(url)
            return _extract_quote_data(driver, symbol)

    except Exception as e:
        print(f"❌ Could not get quote for {symbol}: {e}")
        return None


def _get_single_quote_for_batch(symbol: str) -> Optional[Quote]:
    """Get quote for a single symbol (used in batch processing)."""
    return get_quote(symbol)


def batch_get_quote(
    symbols: List[str],
    max_retries: int = 3,
    max_workers: int = 16,
) -> List[Optional[Quote]]:
    """Get quotes for multiple symbols concurrently with retry mechanism."""
    if not symbols:
        return []

    max_workers = min(len(symbols), os.cpu_count() or 4, max_workers)
    results = [None] * len(symbols)

    for attempt in range(max_retries + 1):
        # Find symbols that still need processing
        failed_indices = [i for i, result in enumerate(results) if result is None]
        if not failed_indices:
            break

        symbols_to_retry = [symbols[i] for i in failed_indices]

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit tasks and track their original indices
            future_to_index = {
                executor.submit(
                    _get_single_quote_for_batch,
                    symbol,
                ): failed_indices[i]
                for i, symbol in enumerate(symbols_to_retry)
            }

            # Process completed tasks with progress bar
            completed_futures = tqdm(
                as_completed(future_to_index.keys()),
                total=len(symbols_to_retry),
                desc=f"Attempt {attempt + 1}/{max_retries + 1}",
            )

            for future in completed_futures:
                original_index = future_to_index[future]
                try:
                    quote = future.result()
                    if quote is not None:
                        results[original_index] = quote
                except Exception as e:
                    print(f"❌ Task failed for {symbols[original_index]}: {e}")

    return results
