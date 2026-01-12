"""Image input utilities for OpenAI Chat Completions API.

Creates image content blocks compatible with OpenAI's Chat Completions API format (used by OpenRouter).
"""

import base64
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage

# Supported image file types: extension -> mime_type
SUPPORTED_IMAGE_EXTENSIONS: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


class MediaMessage(HumanMessage):
    """HumanMessage with image content for Chat Completions API.

    Supports file paths or raw bytes for images. Auto-detects image types from paths.

    Args:
        media: File path(s) or bytes. Can be a single path/bytes or a list.
        description: Optional text description to append after media.

    Example:
        >>> MediaMessage("image.png", "What's in this image?")
        >>> MediaMessage([b"image1", b"image2"], "Describe these images")
    """

    def __init__(
        self,
        media: str | Path | bytes | list[str | Path | bytes],
        description: str = "",
    ):
        items = [media] if isinstance(media, (str, Path, bytes)) else list(media)
        content_blocks: list[dict[str, Any]] = []

        for item in items:
            if isinstance(item, bytes):
                encoded = base64.b64encode(item).decode("utf-8")
                data_url = f"data:image/jpeg;base64,{encoded}"
            else:
                path = Path(item)
                if not path.exists():
                    raise FileNotFoundError(f"File not found: {path}")

                suffix = path.suffix.lower()
                if suffix not in SUPPORTED_IMAGE_EXTENSIONS:
                    supported = ", ".join(sorted(SUPPORTED_IMAGE_EXTENSIONS.keys()))
                    raise ValueError(f"Unsupported extension: {suffix}. Supported: {supported}")

                mime_type = SUPPORTED_IMAGE_EXTENSIONS[suffix]
                encoded = base64.b64encode(path.read_bytes()).decode("utf-8")
                data_url = f"data:{mime_type};base64,{encoded}"

            content_blocks.append({"type": "image_url", "image_url": {"url": data_url}})

        if description:
            content_blocks.append({"type": "text", "text": description})

        super().__init__(content=content_blocks)
