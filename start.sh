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

find_open_port() {
	local host="$1"
	local port="$2"
	while is_port_open "${host}" "${port}"; do
		port=$((port + 1))
	done
	echo "${port}"
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
pnpm run ui:build >/dev/null

if is_port_open "${BACKEND_HOST}" "${BACKEND_PORT}"; then
	if http_is_healthy "http://${BACKEND_HOST}:${BACKEND_PORT}/"; then
		echo "Backend already running on http://${BACKEND_HOST}:${BACKEND_PORT}"
	elif kill_listener_if_matches "${BACKEND_PORT}" "tsx watch src/node.ts"; then
		PORT="${BACKEND_PORT}" pnpm run server:dev &
		backend_pid=$!
	else
		echo "Port ${BACKEND_PORT} is in use by another process and the backend is not healthy."
		echo "Run with BACKEND_PORT=<port> pnpm run dev to use a different backend port."
	fi
else
	PORT="${BACKEND_PORT}" pnpm run server:dev &
	backend_pid=$!
fi

if is_port_open "${FRONTEND_HOST}" "${FRONTEND_PORT}"; then
	if http_is_healthy "http://${FRONTEND_HOST}:${FRONTEND_PORT}/"; then
		echo "Frontend already running on http://${FRONTEND_HOST}:${FRONTEND_PORT}"
	elif kill_listener_if_matches "${FRONTEND_PORT}" "next dev ui"; then
		FRONTEND_HOST="${FRONTEND_HOST}" FRONTEND_PORT="${FRONTEND_PORT}" pnpm run ui:dev &
		frontend_pid=$!
	else
		frontend_command="$(command_for_pid "$(port_pid "${FRONTEND_PORT}")")"
		echo "Frontend port ${FRONTEND_PORT} is in use by another process: ${frontend_command}"
		FRONTEND_PORT="$(find_open_port "${FRONTEND_HOST}" "$((FRONTEND_PORT + 1))")"
		echo "Starting frontend on http://${FRONTEND_HOST}:${FRONTEND_PORT}"
		FRONTEND_HOST="${FRONTEND_HOST}" FRONTEND_PORT="${FRONTEND_PORT}" pnpm run ui:dev &
		frontend_pid=$!
	fi
else
	FRONTEND_HOST="${FRONTEND_HOST}" FRONTEND_PORT="${FRONTEND_PORT}" pnpm run ui:dev &
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
