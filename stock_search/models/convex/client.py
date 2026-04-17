"""Call the Convex HTTP API for query, mutation, and action requests."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx


class ConvexAPIError(RuntimeError):
    """Raised when Convex returns an error status payload."""


class ConvexHttpAdapter:
    """Small HTTP wrapper for Convex query/mutation/action endpoints."""

    def __init__(
        self,
        *,
        base_url: str,
        deploy_key: str,
        timeout_seconds: float = 20.0,
        max_retries: int = 2,
    ) -> None:
        """Initialize the Convex HTTP adapter with connection settings."""
        if not base_url:
            raise RuntimeError("Missing CONVEX_URL for Convex data store.")
        if not deploy_key:
            raise RuntimeError("Missing CONVEX_DEPLOY_KEY for Convex data store.")
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._max_retries = max(0, max_retries)
        self._headers = {
            "Content-Type": "application/json",
            "Authorization": f"Convex {deploy_key}",
        }
        self._client = httpx.Client(timeout=self._timeout)
        self._async_client = httpx.AsyncClient(timeout=self._timeout)
        self._async_close_task: asyncio.Task[None] | None = None

    def query(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex query function."""
        return self._call(endpoint="query", path=path, args=args)

    def mutation(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex mutation function."""
        return self._call(endpoint="mutation", path=path, args=args)

    def action(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex action function."""
        return self._call(endpoint="action", path=path, args=args)

    async def aquery(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex query function asynchronously."""
        return await self._acall(endpoint="query", path=path, args=args)

    async def amutation(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex mutation function asynchronously."""
        return await self._acall(endpoint="mutation", path=path, args=args)

    async def aaction(self, path: str, args: dict[str, Any] | None = None) -> Any:
        """Call a Convex action function asynchronously."""
        return await self._acall(endpoint="action", path=path, args=args)

    def _request_body(self, path: str, args: dict[str, Any] | None) -> dict[str, Any]:
        """Build the JSON payload sent to a Convex endpoint."""
        return {"path": path, "args": args or {}, "format": "json"}

    def _call(self, *, endpoint: str, path: str, args: dict[str, Any] | None) -> Any:
        """Send a synchronous request to one Convex endpoint."""
        response: httpx.Response | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.post(
                    f"{self._base_url}/api/{endpoint}",
                    headers=self._headers,
                    json=self._request_body(path, args),
                )
                break
            except httpx.HTTPError:
                if attempt >= self._max_retries:
                    raise
                time.sleep(0.25 * (attempt + 1))
        if response is None:
            raise RuntimeError("Convex request failed before receiving a response.")
        response.raise_for_status()
        return self._parse_payload(response.json(), endpoint=endpoint, path=path)

    async def _acall(self, *, endpoint: str, path: str, args: dict[str, Any] | None) -> Any:
        """Send an asynchronous request to one Convex endpoint."""
        response: httpx.Response | None = None
        for attempt in range(self._max_retries + 1):
            try:
                response = await self._async_client.post(
                    f"{self._base_url}/api/{endpoint}",
                    headers=self._headers,
                    json=self._request_body(path, args),
                )
                break
            except httpx.HTTPError:
                if attempt >= self._max_retries:
                    raise
                await asyncio.sleep(0.25 * (attempt + 1))
        if response is None:
            raise RuntimeError("Convex async request failed before receiving a response.")
        response.raise_for_status()
        return self._parse_payload(response.json(), endpoint=endpoint, path=path)

    @staticmethod
    def _parse_payload(payload: dict[str, Any], *, endpoint: str, path: str) -> Any:
        """Extract the successful value from a Convex response payload."""
        status = payload.get("status")
        if status != "success":
            error_message = str(payload.get("errorMessage") or "Unknown Convex error")
            raise ConvexAPIError(f"Convex {endpoint} failed for {path}: {error_message}")
        return payload.get("value")

    def close(self) -> None:
        """Close the shared HTTP clients used by this adapter."""
        self._client.close()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self._async_client.aclose())
            return

        self._async_close_task = loop.create_task(self._async_client.aclose())
