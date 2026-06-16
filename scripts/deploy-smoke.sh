#!/usr/bin/env bash
set -euo pipefail

compose_files=(-f docker-compose.yml -f docker-compose.local-smoke.yml)

echo "[pi-for-excel] Building and starting local Docker smoke deploy..."
docker compose "${compose_files[@]}" up -d --build

echo "[pi-for-excel] Checking manifest..."
curl -kfsS https://localhost/manifest.prod.xml >/tmp/pi-for-excel-manifest.prod.xml
grep -q 'https://localhost/src/taskpane.html' /tmp/pi-for-excel-manifest.prod.xml

echo "[pi-for-excel] Checking runtime config..."
runtime_config="$(curl -kfsS https://localhost/runtime-config.json)"
printf '%s\n' "$runtime_config" | grep -q 'https://localhost/llm-gateway/v1'
printf '%s\n' "$runtime_config" | grep -q 'proxied-by-docker'

echo "[pi-for-excel] Checking LLM gateway..."
models_response="$(curl -kfsS https://localhost/llm-gateway/v1/models)"
printf '%s\n' "$models_response" | grep -q '"object":"list"'

echo "[pi-for-excel] Local deploy smoke passed."
echo "[pi-for-excel] Manifest: https://localhost/manifest.prod.xml"
