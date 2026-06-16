#!/bin/sh
set -eu

json_string() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e ':a;N;$!ba;s/\n/\\n/g'
}

trim_trailing_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

gateway_upstream_origin() {
  printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*$#\1#'
}

gateway_upstream_path() {
  path="$(printf '%s' "$1" | sed -E 's#^https?://[^/]+/?##' | sed 's:/*$::')"
  if [ -n "$path" ]; then
    printf '/%s' "$path"
  fi
}

gateway_proxy_enabled() {
  [ "${CORPORATE_GATEWAY_PROXY:-1}" != "0" ] \
    && [ -n "${CORPORATE_GATEWAY_BASE_URL:-}" ] \
    && [ -n "${CORPORATE_GATEWAY_MODEL:-}" ]
}

write_runtime_config() {
  config_path="/usr/share/caddy/runtime-config.json"

  if [ -n "${CORPORATE_GATEWAY_BASE_URL:-}" ] && [ -n "${CORPORATE_GATEWAY_MODEL:-}" ]; then
    name="$(json_string "${CORPORATE_GATEWAY_NAME:-Company LLM}")"
    if gateway_proxy_enabled; then
      public_base_url="$(trim_trailing_slashes "$ADDIN_BASE_URL")"
      upstream_path="$(gateway_upstream_path "$CORPORATE_GATEWAY_BASE_URL")"
      base_url="$(json_string "$public_base_url/llm-gateway$upstream_path")"
      api_key="proxied-by-docker"
    else
      base_url="$(json_string "$(trim_trailing_slashes "$CORPORATE_GATEWAY_BASE_URL")")"
      api_key="$(json_string "${CORPORATE_GATEWAY_API_KEY:-}")"
    fi
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

  sed "s#https://localhost:3000#$base_url#g" /app/manifest.xml > /usr/share/caddy/manifest.prod.xml
}

write_caddyfile() {
  site_address="${ADDIN_SITE_ADDRESS:-:8080}"
  caddyfile="/etc/caddy/Caddyfile"

  cat > "$caddyfile" <<EOF
{
	auto_https disable_redirects
}

$site_address {
	root * /usr/share/caddy

EOF

  if [ -n "${CADDY_TLS_CERT_FILE:-}" ] && [ -n "${CADDY_TLS_KEY_FILE:-}" ]; then
    cat >> "$caddyfile" <<EOF
	tls $CADDY_TLS_CERT_FILE $CADDY_TLS_KEY_FILE

EOF
  elif [ "${CADDY_TLS_INTERNAL:-}" = "1" ]; then
    cat >> "$caddyfile" <<EOF
	tls internal

EOF
  fi

  cat >> "$caddyfile" <<'EOF'
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
	}

EOF

  if gateway_proxy_enabled; then
    upstream_origin="$(gateway_upstream_origin "$CORPORATE_GATEWAY_BASE_URL")"
    cat >> "$caddyfile" <<EOF
	handle_path /llm-gateway/* {
		reverse_proxy $upstream_origin {
			header_up Host {upstream_hostport}
			header_up -Origin
			header_up -Referer
EOF

    if [ -n "${CORPORATE_GATEWAY_API_KEY:-}" ]; then
      cat >> "$caddyfile" <<EOF
			header_up Authorization "Bearer ${CORPORATE_GATEWAY_API_KEY}"
EOF
    fi

    if [ "${CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY:-0}" = "1" ]; then
      cat >> "$caddyfile" <<'EOF'
			transport http {
				tls_insecure_skip_verify
			}
EOF
    fi

    cat >> "$caddyfile" <<'EOF'
		}
	}

EOF
  fi

  cat >> "$caddyfile" <<'EOF'
	@runtimeConfig path /runtime-config.json
	header @runtimeConfig Cache-Control "no-store"

	@manifest path /manifest.prod.xml
	header @manifest Cache-Control "no-store"

	file_server
}
EOF
}

write_runtime_config
write_manifest
write_caddyfile

exec "$@"
