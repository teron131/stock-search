"""Expose the FastAPI app lazily to avoid import cycles."""

from __future__ import annotations

from fastapi import FastAPI

__all__ = ["app"]


def __getattr__(name: str) -> FastAPI:
    """Load the FastAPI app only when requested."""
    if name != "app":
        raise AttributeError(name)

    from .app import app

    return app
