import json
import os
from time import sleep
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from google.genai import Client, types
from pydantic import BaseModel, Field
from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

load_dotenv()


class StockInfo(BaseModel):
    """Represents the information for a single stock in the heatmap."""

    symbol: str = Field(description="The symbol / ticker of the stock")
    regular_change_percent: Optional[float] = Field(default=None, description="The regular change percent")
    performance_1m: Optional[float] = Field(default=None, description="The performance in the last 1 month")


class HeatmapAnalysis(BaseModel):
    """A list of stocks identified in the heatmap image."""

    stocks: List[StockInfo] = Field(description="A list of all stocks and their data from the heatmap.")


def build_heatmap_url(base_url: str, params: Dict[str, Any]) -> str:
    """
    Constructs the TradingView heatmap URL with a JSON fragment.

    Args:
        base_url: The base URL for the heatmap.
        params: A dictionary of parameters to include in the URL fragment.

    Returns:
        The fully constructed URL.
    """
    fragment = json.dumps(params, separators=(",", ":"))
    return f"{base_url}#{fragment}"


def analyze_image_with_gemini(image_bytes: bytes):
    """
    Sends the heatmap image to the Gemini API for structured analysis.

    Args:
        image_bytes: The screenshot image in bytes.
    """
    print("\n--- Sending image to Gemini for analysis ---")
    try:
        client = Client(api_key=os.getenv("GEMINI_API_KEY"))

        prompt = "Extract the data from this image of a stock heatmap. Identify and list all the stock symbols and their corresponding percentage changes as many as possible."

        response = client.models.generate_content(
            model=os.getenv("OCR_LLM"),
            contents=[
                prompt,
                types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=HeatmapAnalysis,
            ),
        )

        print("\n--- Gemini Analysis Result ---")
        if response.parsed:
            analysis: HeatmapAnalysis = response.parsed
            for stock in analysis.stocks:
                print(f"- {stock.symbol}: {stock.regular_change_percent}%")
        else:
            print("Failed to get a structured response from Gemini.")
            print("Raw text:", response.text)
        print("----------------------------")

    except Exception as e:
        print(f"An error occurred during Gemini analysis: {e}")


def capture_and_analyze_heatmap(url: str, wait_time: int = 20):
    """
    Captures a screenshot of the TradingView heatmap and sends it for analysis.

    Args:
        url: The URL of the heatmap to capture.
        wait_time: The maximum time to wait for the page to load.
    """
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument("--headless")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1200,1350")
    chrome_options.add_argument("--disable-sandbox")

    print("Starting headless Chrome browser...")
    try:
        driver = webdriver.Chrome(service=ChromeService(ChromeDriverManager().install()), options=chrome_options)
    except Exception as e:
        print(f"Failed to initialize Chrome Driver: {e}")
        return

    try:
        print(f"Navigating to: {url}")
        driver.get(url)

        print(f"Waiting for heatmap page to load (max {wait_time} seconds)...")
        wait = WebDriverWait(driver, wait_time)
        wait.until(EC.visibility_of_element_located((By.XPATH, "//*[contains(text(), 'Nasdaq 100')]")))

        sleep(2)

        print("Capturing screenshot...")
        png_bytes = driver.get_screenshot_as_png()

        analyze_image_with_gemini(png_bytes)

    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        print("Closing browser.")
        driver.quit()


if __name__ == "__main__":
    BASE_URL = "https://www.tradingview.com/heatmap/stock/"
    heatmap_params = {
        "dataSource": "NASDAQ100",
        "blockColor": "change",
        "blockSize": "market_cap_basic",
        "grouping": "sector",
    }
    heatmap_url = build_heatmap_url(BASE_URL, heatmap_params)

    capture_and_analyze_heatmap(heatmap_url)

    # Another heatmap with blockColor: Perf.1M
    heatmap_params_perf1m = {
        "dataSource": "NASDAQ100",
        "blockColor": "Perf.1M",
        "blockSize": "market_cap_basic",
        "grouping": "sector",
    }
    heatmap_url_perf1m = build_heatmap_url(BASE_URL, heatmap_params_perf1m)
    print("\n--- Generating another heatmap for Perf.1M ---")
    capture_and_analyze_heatmap(heatmap_url_perf1m)
