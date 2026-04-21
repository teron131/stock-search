"""Copy built frontend assets into the Vercel static output directory."""

from __future__ import annotations

from pathlib import Path
import shutil
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = PROJECT_ROOT / "ui" / "dist"
PUBLIC_DIR = PROJECT_ROOT / "public"


def main() -> int:
    """Copy built UI assets into the static output directory."""
    if not DIST_DIR.exists():
        print(f"Missing built UI directory: {DIST_DIR}", file=sys.stderr)
        return 1

    shutil.rmtree(PUBLIC_DIR, ignore_errors=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    for child in DIST_DIR.iterdir():
        if child.name == "index.html":
            continue
        target = PUBLIC_DIR / child.name
        if child.is_dir():
            shutil.copytree(child, target)
            continue
        shutil.copy2(child, target)

    print(f"Prepared Vercel public assets in {PUBLIC_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
