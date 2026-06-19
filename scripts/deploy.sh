#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="preview"
SCOPE="${VERCEL_SCOPE:-teron131s-projects}"
ALIAS_HOST=""
RUN_BUILD=1
FORCE_ENV=1
ENV_FILE="${ENV_FILE:-.env}"
REQUIRED_VERCEL_ENV_KEYS=(
	DATA_STORE_BACKEND
	D1_ACCOUNT_ID
	D1_DATABASE_ID
	D1_API_TOKEN
	AUTH_ENABLED
	AUTH_SECRET
	AUTH_GOOGLE_ID
	AUTH_GOOGLE_SECRET
	ALLOWED_EMAIL
)

usage() {
	cat <<'EOF'
Usage: scripts/deploy.sh [options]

Deploy the stock-search app.

Options:
  --preview           Deploy a preview build (default)
  --prod              Deploy a production build
  --alias <host>      Point a production alias at the new deployment
  --skip-build        Skip local pnpm build verification
  --skip-env          Do not force D1/auth environment variables on Vercel
  --env-file <path>   Source deployment env values from a dotenv file (default: .env)
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
		--skip-env)
			FORCE_ENV=0
			shift
			;;
		--env-file)
			ENV_FILE="${2:-}"
			if [[ -z "$ENV_FILE" ]]; then
				echo "Missing value for --env-file" >&2
				exit 1
			fi
			shift 2
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

dotenv_value() {
	local key="$1"
	node - "$ENV_FILE" "$key" <<'JS'
const fs = require("fs");

const envFile = process.argv[2];
const key = process.argv[3];
if (process.env[key]) {
	console.log(process.env[key]);
	process.exit(0);
}

let text = "";
try {
	text = fs.readFileSync(envFile, "utf8");
} catch (error) {
	if (error.code !== "ENOENT") {
		throw error;
	}
}

for (const line of text.split(/\r?\n/)) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		continue;
	}
	const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
	if (!match || match[1] !== key) {
		continue;
	}
	let value = match[2].trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	console.log(value);
	process.exit(0);
}
JS
}

force_vercel_env() {
	local environment="$1"
	echo "==> Forcing Vercel environment values ($environment)"
	for key in "${REQUIRED_VERCEL_ENV_KEYS[@]}"; do
		local value
		value="$(dotenv_value "$key")"
		if [[ -z "$value" ]]; then
			echo "Missing required deployment env value: $key" >&2
			exit 1
		fi
		echo "    $key"
		vercel env add "$key" "$environment" \
			--force \
			--value "$value" \
			--yes \
			--scope "$SCOPE" >/dev/null
	done
}

if [[ "$FORCE_ENV" -eq 1 ]]; then
	force_vercel_env "$TARGET"
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
	DEPLOY_JSON="$DEPLOY_JSON" node - <<'JS'
const payload = JSON.parse(process.env.DEPLOY_JSON);
console.log(payload.url || payload.deployment?.url || "");
JS
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
