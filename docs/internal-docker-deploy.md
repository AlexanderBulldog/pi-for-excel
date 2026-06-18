# Internal Docker deploy

Goal: host one HTTPS add-in URL, publish one manifest, and preconfigure one
company OpenAI-compatible model for first-run users.

## Architecture

- The **container** is a plain static HTTP server (port `8080`). It serves the
  built taskpane plus two generated files: `runtime-config.json` (first-run
  model config) and `manifest.prod.xml`.
- **Your own Caddy on the host** does TLS and proxying. It:
  1. terminates HTTPS with an IT-issued certificate,
  2. reverse-proxies everything to the container (`127.0.0.1:8080`),
  3. proxies `/llm-gateway/*` to the company LLM, adding the API key
     server-side so the browser never sees it.

Network flow is only `client → host Caddy (one URL/port) → LLM`. Clients never
need direct network access to the LLM; only the host Caddy does. Users enter
nothing — the model is preconfigured via `runtime-config.json`.

## 1. Configure the container

Copy `.env.example` to `.env` and set:

```bash
ADDIN_BASE_URL=https://pi-excel.<company-domain>   # what the host Caddy serves
OPENAI_BASE_URL=https://<company-llm-host>/v1       # URL only (no key here)
LLM_MODEL=<model-id>
```

The real `OPENAI_API_KEY` is **not** put in `.env`. It lives in the host
Caddyfile (step 3), server-side.

## 2. Start the container

```bash
docker compose up -d --build
```

Check it serves over plain HTTP:

```bash
curl http://localhost:8080/manifest.prod.xml
curl http://localhost:8080/runtime-config.json
```

`runtime-config.json` should show a same-origin endpoint like
`https://pi-excel.<company-domain>/llm-gateway/v1` and a placeholder key
`proxied-by-host-caddy` (the real key is added by Caddy).

## 3. Configure the host Caddy

Copy `deploy/Caddyfile.example` and replace three things:

- the site host (must match `ADDIN_BASE_URL`),
- the `tls` cert/key paths (your IT-issued certificate),
- the `/llm-gateway` upstream origin and the `Bearer` API key.

Then run it on the host:

```bash
caddy run --config ./Caddyfile
```

Verify end-to-end through Caddy:

```bash
curl https://pi-excel.<company-domain>/manifest.prod.xml
curl https://pi-excel.<company-domain>/runtime-config.json
curl https://pi-excel.<company-domain>/llm-gateway/v1/models   # should list models
```

Notes:

- Office add-ins require HTTPS with a certificate the client machines trust.
  Self-signed/internal certs won't work for ordinary users — use an IT-issued
  cert in Caddy.
- Keep `tls_insecure_skip_verify` in the Caddyfile only if the upstream LLM uses
  a self-signed certificate; remove it once the upstream CA is trusted.

## 4. Give users the manifest

Send users:

```text
https://pi-excel.<company-domain>/manifest.prod.xml
```

On macOS, sideload by copying the downloaded manifest to:

```text
~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

Then fully quit and reopen Excel. The first opened taskpane already uses the
company model, so users do not need `/settings`.

## Local rehearsal

Smoke-test the static container (no TLS, no LLM proxy — those are the host
Caddy's job):

```bash
npm run deploy:smoke
# or:
docker compose -f docker-compose.yml -f docker-compose.local-smoke.yml up -d --build
curl http://localhost:8080/manifest.prod.xml
curl http://localhost:8080/runtime-config.json
```

To rehearse the full HTTPS + gateway path locally, run a local Caddy from
`deploy/Caddyfile.example` with a `localhost` cert
(`./scripts/create-localhost-cert.sh`) pointing `tls` at `cert.pem`/`key.pem`
and the site address at `localhost`.
