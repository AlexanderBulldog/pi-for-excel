#!/bin/sh
set -eu

# Container responsibilities (static only):
#   - generate runtime-config.json so first-run users get a ready model
#   - generate manifest.prod.xml with the public add-in URL
#   - serve the built taskpane over plain HTTP
#
# TLS termination and the /llm-gateway reverse proxy (which injects the real
# upstream API key) live in the host Caddy. See deploy/Caddyfile.example.

STATIC_ROOT="${STATIC_ROOT:-/usr/share/app}"

json_string() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e ':a;N;$!ba;s/\n/\\n/g'
}

trim_trailing_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

gateway_upstream_path() {
  path="$(printf '%s' "$1" | sed -E 's#^https?://[^/]+/?##' | sed 's:/*$::')"
  if [ -n "$path" ]; then
    printf '/%s' "$path"
  fi
}

write_runtime_config() {
  config_path="$STATIC_ROOT/runtime-config.json"

  if [ -n "${CORPORATE_GATEWAY_BASE_URL:-}" ] && [ -n "${CORPORATE_GATEWAY_MODEL:-}" ]; then
    name="$(json_string "${CORPORATE_GATEWAY_NAME:-Company LLM}")"

    # Browser always talks to the same-origin /llm-gateway path. The host Caddy
    # proxies it to the real LLM and adds the API key server-side, so the key
    # never reaches runtime-config.json or the client.
    public_base_url="$(trim_trailing_slashes "$ADDIN_BASE_URL")"
    upstream_path="$(gateway_upstream_path "$CORPORATE_GATEWAY_BASE_URL")"
    base_url="$(json_string "$public_base_url/llm-gateway$upstream_path")"
    api_key="proxied-by-host-caddy"

    model="$(json_string "$CORPORATE_GATEWAY_MODEL")"
    context_window="${CORPORATE_GATEWAY_CONTEXT_WINDOW:-65536}"

    case "$context_window" in
      ''|*[!0-9]*) context_window="65536" ;;
    esac

    cat > "$config_path" <<EOF
{"corporateGateway":{"enabled":true,"displayName":"$name","endpointUrl":"$base_url","modelId":"$model","apiKey":"$api_key","contextWindow":$context_window}}
EOF
  else
    cat > "$config_path" <<EOF
{"corporateGateway":{"enabled":false}}
EOF
  fi
}

write_manifest() {
  if [ -z "${ADDIN_BASE_URL:-}" ]; then
    echo "[pi-for-excel] ADDIN_BASE_URL is required, e.g. https://pi-excel.company.local" >&2
    exit 1
  fi

  base_url="$(printf '%s' "$ADDIN_BASE_URL" | sed 's:/*$::')"
  case "$base_url" in
    https://*) ;;
    *)
      echo "[pi-for-excel] ADDIN_BASE_URL must start with https:// for Office add-ins" >&2
      exit 1
      ;;
  esac

  sed "s#https://localhost:3000#$base_url#g" /app/manifest.xml > "$STATIC_ROOT/manifest.prod.xml"
}

write_runtime_config
write_manifest

exec "$@"
