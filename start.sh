#!/usr/bin/env bash

set -euo pipefail

BACKEND_HOST="${BACKEND_HOST:-localhost}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-localhost}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

backend_pid=""
frontend_pid=""

is_port_open() {
	local host="$1"
	local port="$2"
	nc -z "$host" "$port" >/dev/null 2>&1
}

port_pid() {
	lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

http_is_healthy() {
	local url="$1"
	curl --silent --show-error --max-time 3 --output /dev/null "$url"
}

command_for_pid() {
	ps -p "$1" -o command= 2>/dev/null || true
}

kill_listener_if_matches() {
	local port="$1"
	local expected="$2"
	local pid
	pid="$(port_pid "$port")"
	if [[ -z "${pid}" ]]; then
		return 1
	fi

	local command
	command="$(command_for_pid "$pid")"
	if [[ "${command}" != *"${expected}"* ]]; then
		return 1
	fi

	echo "Stopping unresponsive process on port ${port}: ${command}"
	kill "$pid" 2>/dev/null || true
	sleep 1
	if kill -0 "$pid" 2>/dev/null; then
		kill -9 "$pid" 2>/dev/null || true
	fi
	return 0
}

cleanup() {
	if [[ -n "${backend_pid}" ]]; then
		kill "${backend_pid}" 2>/dev/null || true
	fi
	if [[ -n "${frontend_pid}" ]]; then
		kill "${frontend_pid}" 2>/dev/null || true
	fi
}

trap cleanup EXIT INT TERM

echo "Building frontend bundle for backend-served pages..."
npm run ui:build >/dev/null

if is_port_open "${BACKEND_HOST}" "${BACKEND_PORT}"; then
	if http_is_healthy "http://${BACKEND_HOST}:${BACKEND_PORT}/"; then
		echo "Backend already running on http://${BACKEND_HOST}:${BACKEND_PORT}"
	elif kill_listener_if_matches "${BACKEND_PORT}" "uvicorn stock_search.api:app"; then
		uv run python -m uvicorn stock_search.api:app --reload --host "${BACKEND_HOST}" --port "${BACKEND_PORT}" &
		backend_pid=$!
	else
		echo "Port ${BACKEND_PORT} is in use by another process and the backend is not healthy."
		echo "Run with BACKEND_PORT=<port> npm run dev to use a different backend port."
	fi
else
	uv run python -m uvicorn stock_search.api:app --reload --host "${BACKEND_HOST}" --port "${BACKEND_PORT}" &
	backend_pid=$!
fi

if is_port_open "${FRONTEND_HOST}" "${FRONTEND_PORT}"; then
	echo "Frontend already running on http://${FRONTEND_HOST}:${FRONTEND_PORT}"
else
	npm run ui:dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}" &
	frontend_pid=$!
fi

echo "Backend URL:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Frontend URL: http://${FRONTEND_HOST}:${FRONTEND_PORT}"

if [[ -z "${backend_pid}" && -z "${frontend_pid}" ]]; then
	exit 0
fi

while true; do
	if [[ -n "${backend_pid}" ]] && ! kill -0 "${backend_pid}" 2>/dev/null; then
		break
	fi
	if [[ -n "${frontend_pid}" ]] && ! kill -0 "${frontend_pid}" 2>/dev/null; then
		break
	fi
	sleep 1
done
