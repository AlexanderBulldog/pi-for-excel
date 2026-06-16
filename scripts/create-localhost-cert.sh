#!/usr/bin/env bash
set -euo pipefail

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[pi-for-excel] mkcert is required for local Excel smoke tests.

Install it on macOS:
  brew install mkcert

Then run:
  ./scripts/create-localhost-cert.sh

EOF
  exit 1
fi

mkcert -install
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1

echo "[pi-for-excel] Wrote cert.pem and key.pem for https://localhost"
