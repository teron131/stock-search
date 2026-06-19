#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="preview"
SCOPE="${VERCEL_SCOPE:-teron131s-projects}"
ALIAS_HOST=""
RUN_BUILD=1

usage() {
	cat <<'EOF'
Usage: scripts/deploy.sh [options]

Deploy the stock-search app.

Options:
  --preview           Deploy a preview build (default)
  --prod              Deploy a production build
  --alias <host>      Point a production alias at the new deployment
  --skip-build        Skip local pnpm build verification
  --scope <team>      Override Vercel scope/team slug
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--preview)
			TARGET="preview"
			shift
			;;
		--prod)
			TARGET="production"
			shift
			;;
		--alias)
			ALIAS_HOST="${2:-}"
			if [[ -z "$ALIAS_HOST" ]]; then
				echo "Missing value for --alias" >&2
				exit 1
			fi
			shift 2
			;;
		--skip-build)
			RUN_BUILD=0
			shift
			;;
		--scope)
			SCOPE="${2:-}"
			if [[ -z "$SCOPE" ]]; then
				echo "Missing value for --scope" >&2
				exit 1
			fi
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if [[ -n "$ALIAS_HOST" && "$TARGET" != "production" ]]; then
	echo "--alias is only supported with --prod" >&2
	exit 1
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
	echo "==> Building app"
	pnpm run build
fi

echo "==> Deploying to Vercel ($TARGET)"
DEPLOY_ARGS=(deploy -y --scope "$SCOPE" --format json)
if [[ "$TARGET" == "production" ]]; then
	DEPLOY_ARGS+=(--prod)
fi

DEPLOY_JSON="$(vercel "${DEPLOY_ARGS[@]}")"
echo "$DEPLOY_JSON"

DEPLOY_URL="$(
	DEPLOY_JSON="$DEPLOY_JSON" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["DEPLOY_JSON"])
url = payload.get("url") or payload.get("deployment", {}).get("url") or ""
print(url)
PY
)"

if [[ -z "$DEPLOY_URL" ]]; then
	echo "Failed to determine deployment URL from Vercel output." >&2
	exit 1
fi

if [[ -n "$ALIAS_HOST" ]]; then
	echo "==> Assigning alias $ALIAS_HOST"
	vercel alias set "$DEPLOY_URL" "$ALIAS_HOST" --scope "$SCOPE"
fi

echo "==> Deployment ready"
echo "$DEPLOY_URL"
