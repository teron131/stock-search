# Use Python slim image
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies and Chrome using modern key management
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    unzip \
    curl \
    && mkdir -p /etc/apt/keyrings \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Prefer Selenium Manager to resolve the correct driver at runtime.
# Optionally, keep a best-effort fallback by installing a matching ChromeDriver version.
# Note: Selenium Manager usually removes the need for this block; leaving commented for reference.
# RUN CHROME_VERSION=$(google-chrome --version | awk '{print $3}') \
#     && MAJOR_VERSION=$(echo "$CHROME_VERSION" | cut -d'.' -f1) \
#     && echo "Detected Chrome version: $CHROME_VERSION (major $MAJOR_VERSION)" \
#     && wget -qO- https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json | \
#        python - << 'PY' > /tmp/chromedriver_url.txt \
# import json, sys, os; \
# data=json.load(sys.stdin); \
# major=os.environ.get('MAJOR_VERSION'); \
# versions=[v for v in data['versions'] if v['version'].split('.')[0]==major]; \
# latest=versions[-1]; \
# urls=[d['url'] for d in latest['downloads']['chromedriver'] if d['platform']=='linux64'][0]; \
# print(urls)
# PY \
#     && wget -O /tmp/chromedriver.zip $(cat /tmp/chromedriver_url.txt) \
#     && unzip /tmp/chromedriver.zip -d /tmp \
#     && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/chromedriver \
#     && chmod +x /usr/local/bin/chromedriver \
#     && rm -rf /tmp/chromedriver.zip /tmp/chromedriver-linux64 /tmp/chromedriver_url.txt

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]