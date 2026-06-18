#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the static add-in container (no TLS, no LLM proxy here — those
# live in the host Caddy, see deploy/Caddyfile.example).

compose_files=(-f docker-compose.yml -f docker-compose.local-smoke.yml)

echo "[pi-for-excel] Building and starting local container..."
docker compose "${compose_files[@]}" up -d --build

base="http://localhost:8080"

echo "[pi-for-excel] Waiting for the static server..."
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "$base/runtime-config.json" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "[pi-for-excel] Checking taskpane is served..."
curl -fsS "$base/src/taskpane.html" >/dev/null

echo "[pi-for-excel] Checking manifest..."
curl -fsS "$base/manifest.prod.xml" >/tmp/pi-for-excel-manifest.prod.xml
grep -q 'https://localhost/src/taskpane.html' /tmp/pi-for-excel-manifest.prod.xml

echo "[pi-for-excel] Checking runtime config..."
runtime_config="$(curl -fsS "$base/runtime-config.json")"
printf '%s\n' "$runtime_config" | grep -q 'https://localhost/llm-gateway/v1'
printf '%s\n' "$runtime_config" | grep -q 'proxied-by-host-caddy'

echo "[pi-for-excel] Container smoke passed."
echo "[pi-for-excel] Note: TLS + /llm-gateway proxy are validated with the host Caddy (deploy/Caddyfile.example)."
