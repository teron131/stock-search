import re

from rich import print
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

from stock_search.schema import Quote


def get_driver() -> webdriver.Chrome:
    # Set up Chrome options
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")  # ⚡ faster headless mode
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1200,800")

    # Disable images, CSS, and web-fonts → smaller downloads
    prefs = {
        "profile.managed_default_content_settings.images": 2,
        "profile.managed_default_content_settings.stylesheets": 2,
        "profile.managed_default_content_settings.fonts": 2,
    }
    chrome_options.add_experimental_option("prefs", prefs)

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
        {"urls": ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.css", "*.woff", "*.woff2", "*.ttf", "*doubleclick*", "*googlesyndication*", "*analytics*"]},  # wild-cards allowed
    )
    driver.implicitly_wait(2)  # we can tighten this a bit

    return driver


def close_driver():
    """Closes the webdriver."""
    if driver:
        driver.quit()


driver = get_driver()


def get_quote(symbol: str) -> Quote:
    """Get the price and change (including premarket and postmarket) for a given symbol from Yahoo Finance."""
    # Load the Yahoo Finance page for the given symbol
    url = f"https://finance.yahoo.com/quote/{symbol}/"
    driver.get(url)

    # Wait for the page to load
    wait = WebDriverWait(driver, 5)  # shorter explicit wait – DOM is ready sooner

    print(f"Page for {symbol} loaded successfully!")

    # Optionally, extract specific elements like the stock price
    try:
        # Wait only for the first price element
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='qsp-price']")))

        # Now fetch everything without extra waits
        regular_price = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-price']")
        regular_change = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-price-change']")
        regular_change_percent = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-price-change-percent']")
        premarket_price = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-pre-price']")
        premarket_change = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-pre-price-change']")
        premarket_change_percent = driver.find_element(By.CSS_SELECTOR, "[data-testid='qsp-pre-price-change-percent']")

        return Quote(
            regular_price=regular_price.text,
            regular_change=regular_change.text,
            regular_change_percent=re.sub(r"[()]+", "", regular_change_percent.text),
            premarket_price=premarket_price.text,
            premarket_change=premarket_change.text,
            premarket_change_percent=re.sub(r"[()]+", "", premarket_change_percent.text),
        )

    except Exception as e:
        print(f"Could not extract price element for {symbol}: {e}")
        return None


# Robinhood
# def get_quote(symbol: str) -> tuple[str, str]:
#     """Get the price and change (including premarket and postmarket) for a given symbol."""
#     instrument_id = requests.get(f"https://api.robinhood.com/quotes/{symbol}/").json()["instrument_id"]

#     bonfire = requests.get(f"https://bonfire.robinhood.com/instruments/{instrument_id}/detail-page-live-updating-data/?display_span=day&hide_extended_hours=false").json()

#     price = bonfire["chart_section"]["default_display"]["primary_value"]["value"]
#     change = bonfire["chart_section"]["default_display"]["secondary_value"]["main"]["value"]

#     return price, change

if __name__ == "__main__":
    try:
        amd_quote = get_quote("AMD")
        if amd_quote:
            print(amd_quote)
    finally:
        close_driver()
