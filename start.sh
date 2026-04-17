#!/usr/bin/env bash

set -euo pipefail

backend_pid=""
frontend_pid=""

is_port_open() {
	nc -z localhost "$1" >/dev/null 2>&1
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

if is_port_open 8000; then
	echo "Backend already running on http://localhost:8000"
else
	uv run python -m uvicorn stock_search.api:app --reload --host localhost &
	backend_pid=$!
fi

if is_port_open 5173; then
	echo "Frontend already running on http://localhost:5173"
else
	npm run ui:dev &
	frontend_pid=$!
fi

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
