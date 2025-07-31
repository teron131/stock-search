import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List

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


def get_driver() -> webdriver.Chrome:
    # Set up Chrome options for maximum speed
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")  # ⚡ faster headless mode
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-extensions")
    chrome_options.add_argument("--disable-plugins")
    chrome_options.add_argument("--disable-images")
    # chrome_options.add_argument("--disable-javascript")  # Yahoo Finance needs JS
    chrome_options.add_argument("--disable-web-security")
    chrome_options.add_argument("--disable-features=VizDisplayCompositor")
    chrome_options.add_argument("--disable-background-timer-throttling")
    chrome_options.add_argument("--disable-renderer-backgrounding")
    chrome_options.add_argument("--disable-backgrounding-occluded-windows")
    chrome_options.add_argument("--disable-client-side-phishing-detection")
    chrome_options.add_argument("--disable-crash-reporter")
    chrome_options.add_argument("--disable-oopr-debug-crash-dump")
    chrome_options.add_argument("--no-crash-upload")
    chrome_options.add_argument("--disable-low-res-tiling")
    chrome_options.add_argument("--memory-pressure-off")
    chrome_options.add_argument("--window-size=1200,800")

    # ULTRA aggressive disable content for speed
    prefs = {
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
        "profile.managed_default_content_settings.media_stream": 2,
    }
    chrome_options.add_experimental_option("prefs", prefs)
    chrome_options.add_experimental_option("useAutomationExtension", False)
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])

    # Return immediately (pageLoadStrategy='none') – we'll wait only for what we need
    caps = chrome_options.to_capabilities()
    caps["pageLoadStrategy"] = "none"  # ⏱️ fastest strategy

    # Initialize the webdriver (create once, reuse for many symbols)
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(
        service=service,
        options=chrome_options,
    )

    # ––– Extra speed: block un-needed network requests via Chrome DevTools Protocol
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd(
        "Network.setBlockedURLs",
        {"urls": ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.ico", "*.css", "*.woff", "*.woff2", "*.ttf", "*.otf", "*doubleclick*", "*googlesyndication*", "*analytics*", "*gtag*", "*facebook*", "*twitter*", "*linkedin*", "*pinterest*", "*ads*", "*ad.*", "*advertising*", "*metrics*", "*chartbeat*", "*optimizely*", "*hotjar*", "*mixpanel*", "*.mp4", "*.webm", "*.ogg", "*.mp3", "*.wav", "*cdn.jsdelivr*", "*cdnjs*", "*unpkg*", "*bootstrap*", "*jquery*", "*tracking*"]},
    )

    # Add user agent and more CDP optimizations
    driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"})
    driver.execute_cdp_cmd("Runtime.enable", {})

    # Inject performance script to stop loading early
    driver.execute_cdp_cmd("Runtime.addBinding", {"name": "stopLoading"})

    driver.implicitly_wait(0.5)  # Even more aggressive - 0.5 seconds

    return driver


def close_driver():
    """Closes the webdriver."""
    if driver:
        driver.quit()


driver = get_driver()


def safe_get_text(driver: webdriver.Chrome, primary_selector: str, fallback_selector: str = None, default: str = None) -> str:
    """Helper function to safely get element text with fallback selectors."""
    try:
        element = driver.find_element(By.CSS_SELECTOR, primary_selector)
        return element.text if element.text else default
    except:
        if fallback_selector:
            try:
                element = driver.find_element(By.CSS_SELECTOR, fallback_selector)
                return element.text if element.text else default
            except:
                return default
        return default


def _get_quote_with_driver(symbol: str, driver_instance: webdriver.Chrome) -> Quote:
    """Internal function to get quote using a specific driver instance."""
    start_time = time.time()

    try:
        # Load the Yahoo Finance page for the given symbol
        url = f"https://finance.yahoo.com/quote/{symbol}/"
        driver_instance.get(url)

        # Ultra-fast wait with balanced timeout
        wait = WebDriverWait(driver_instance, 3.0)  # Sweet spot for speed vs reliability

        # Wait only for the main price element (fastest single check)
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Ultra-fast batch element finding - only get elements that actually exist
        elements = driver_instance.find_elements(By.CSS_SELECTOR, "[data-testid^='qsp-']")
        element_dict = {elem.get_attribute("data-testid"): elem for elem in elements}

        # Get regular market data (these always exist)
        regular_price = element_dict.get("qsp-price")
        regular_change = element_dict.get("qsp-price-change")
        regular_change_percent = element_dict.get("qsp-price-change-percent")

        # Check for premarket/overnight data with simplified logic
        realtime_price_elem = element_dict.get("qsp-pre-price") or element_dict.get("qsp-overnight-price")
        realtime_change_elem = element_dict.get("qsp-pre-price-change") or element_dict.get("qsp-overnight-price-change")
        realtime_change_percent_elem = element_dict.get("qsp-pre-price-change-percent") or element_dict.get("qsp-overnight-price-change-percent")

        # Stop page loading immediately after getting data
        try:
            driver_instance.execute_script("window.stop();")
        except:
            pass

        elapsed_time = time.time() - start_time
        print(f"✅ Scraped {symbol} in {elapsed_time:.2f} seconds")

        return Quote(
            regular_price=regular_price.text if regular_price else None,
            regular_change=regular_change.text if regular_change else None,
            regular_change_percent=re.sub(r"[()]+", "", regular_change_percent.text) if regular_change_percent else None,
            realtime_price=realtime_price_elem.text if realtime_price_elem else None,
            realtime_change=realtime_change_elem.text if realtime_change_elem else None,
            realtime_change_percent=re.sub(r"[()]+", "", realtime_change_percent_elem.text) if realtime_change_percent_elem else None,
        )

    except Exception as e:
        print(f"❌ Could not extract price element for {symbol}: {e}")
        return None


def get_quote(symbol: str) -> Quote:
    """Get the price and change (including premarket and overnight) for a given symbol from Yahoo Finance."""
    return _get_quote_with_driver(symbol, driver)


def _get_single_quote_with_own_driver(symbol: str) -> Quote:
    """Get quote for a single symbol using its own driver instance (for concurrent use)."""
    local_driver = None
    try:
        local_driver = get_driver()
        return _get_quote_with_driver(symbol, local_driver)
    except Exception as e:
        print(f"❌ Error fetching quote for {symbol}: {e}")
        return None
    finally:
        if local_driver:
            try:
                local_driver.quit()
            except:
                pass  # Ignore cleanup errors


def batch_get_quote(symbols: List[str], max_retries: int = 2) -> List[Quote]:
    """Get quotes for multiple symbols concurrently with retry mechanism.

    Args:
        symbols: List of stock symbols to fetch quotes for
        max_retries: Maximum number of retry attempts for failed quotes

    Returns:
        List of Quote objects (may contain None for quotes that failed all retries)
    """
    if not symbols:
        return []

    # Limit workers to avoid overwhelming the system and Yahoo Finance
    max_workers = min(len(symbols), os.cpu_count(), 8)  # Cap at 8 concurrent requests
    results = [None] * len(symbols)

    for attempt in range(max_retries + 1):
        # Find which symbols still need to be fetched
        symbols_to_fetch = [symbols[i] for i, result in enumerate(results) if result is None]

        if not symbols_to_fetch:
            break  # All symbols successfully fetched

        attempt_desc = f"Attempt {attempt + 1}" if attempt > 0 else "Initial fetch"
        print(f"🚀 {attempt_desc}: Fetching quotes for {len(symbols_to_fetch)} symbols using {max_workers} workers...")

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            batch_results = list(tqdm(executor.map(_get_single_quote_with_own_driver, symbols_to_fetch), total=len(symbols_to_fetch), desc=f"Fetching quotes ({attempt_desc.lower()})"))

        # Update results for successful fetches
        for symbol, quote in zip(symbols_to_fetch, batch_results):
            original_index = symbols.index(symbol)
            if quote is not None:
                results[original_index] = quote
                print(f"✅ {symbol}: Successfully fetched")
            else:
                if attempt < max_retries:
                    print(f"🔄 {symbol}: Failed, will retry")
                else:
                    print(f"❌ {symbol}: Failed after {max_retries + 1} attempts")

        # Add delay between retries
        if symbols_to_fetch and attempt < max_retries:
            print(f"⏳ Waiting 2 seconds before retry...")
            time.sleep(2)

    return results


# Robinhood
# def get_quote(symbol: str) -> tuple[str, str]:
#     """Get the price and change (including premarket and postmarket) for a given symbol."""
#     instrument_id = requests.get(f"https://api.robinhood.com/quotes/{symbol}/").json()["instrument_id"]

#     bonfire = requests.get(f"https://bonfire.robinhood.com/instruments/{instrument_id}/detail-page-live-updating-data/?display_span=day&hide_extended_hours=false").json()

#     price = bonfire["chart_section"]["default_display"]["primary_value"]["value"]
#     change = bonfire["chart_section"]["default_display"]["secondary_value"]["main"]["value"]

#     return price, change
