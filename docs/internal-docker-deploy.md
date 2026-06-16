# Internal Docker deploy

Goal: host one HTTPS add-in URL, publish one manifest, and preconfigure one
company OpenAI-compatible model for first-run users.

## Lead handoff

Give the lead this repo plus a filled `.env`. They need to decide only three
things:

- public add-in URL: `ADDIN_BASE_URL`
- how HTTPS is terminated: existing reverse proxy, mounted cert/key, or Caddy
  internal TLS for a small pilot
- company LLM endpoint/model/key: `OPENAI_BASE_URL`, `LLM_MODEL`,
  `OPENAI_API_KEY`

Recommended internal deployment:

```bash
ADDIN_BASE_URL=https://pi-excel.<company-domain>
ADDIN_SITE_ADDRESS=:8080
OPENAI_BASE_URL=https://<company-llm-host>/v1
LLM_MODEL=<model-id>
OPENAI_API_KEY=<gateway-key-if-required>
CORPORATE_GATEWAY_PROXY=1
CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY=1
```

Run:

```bash
docker compose up -d --build
```

Then publish this manifest URL to testers:

```text
https://pi-excel.<company-domain>/manifest.prod.xml
```

Expected first-run behavior: users install the manifest, open Pi for Excel,
and can chat immediately. They should not need `/settings`.

Important notes:

- Office add-ins require HTTPS. Plain HTTP will not work for real users.
- With `CORPORATE_GATEWAY_PROXY=1`, the browser talks to
  `/llm-gateway/...`; Caddy adds the real upstream API key server-side.
- The add-in may store/show a placeholder key `proxied-by-docker`. That is
  expected and is not the real secret.
- `CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY=1` is acceptable for a pilot
  with an internal/self-signed LLM certificate. For production, install the
  company CA in the container and set it to `0`.
- The in-app warning “Proxy not running” refers to optional OAuth/local helper
  features, not the Docker LLM gateway. It can be ignored for this pilot.

## 1. Configure

For now the only required model values are:

```bash
OPENAI_BASE_URL=https://llm.company.local/v1
LLM_MODEL=your-model-id
```

`ADDIN_BASE_URL` has a temporary default:

```bash
ADDIN_BASE_URL=https://pi-excel.internal.test
```

Replace that one line when the final internal URL is approved.

`OPENAI_API_KEY` is optional. If you set it, remember it is delivered to the
Docker/Caddy gateway, not to the browser. The browser receives a same-origin
`/llm-gateway/...` endpoint in `/runtime-config.json`, which avoids Office
WebView CORS issues.

## 2. Start

```bash
docker compose up -d --build
```

Check:

```bash
curl -k "$ADDIN_BASE_URL/manifest.prod.xml"
curl -k "$ADDIN_BASE_URL/runtime-config.json"
```

`runtime-config.json` should show an endpoint like:

```text
https://your-addin-host/llm-gateway/v1
```

It should not expose the raw API key when `CORPORATE_GATEWAY_PROXY=1`.
The add-in may show a harmless placeholder key (`proxied-by-docker`) because
the client library requires a non-empty API key for OpenAI-compatible gateways;
Caddy replaces it with the real upstream key server-side.

If the internal LLM endpoint uses a company/self-signed certificate, keep:

```bash
CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY=1
```

For a hardened deployment, install the company CA in the image/container and
set this to `0`.

## Local deployment rehearsal

Use this to test the Docker-hosted build exactly like a tester will consume it,
without waiting for the final internal domain:

```bash
./scripts/create-localhost-cert.sh
docker compose -f docker-compose.yml -f docker-compose.local-smoke.yml up -d --build
curl -k https://localhost/manifest.prod.xml
curl -k https://localhost/runtime-config.json
```

Then sideload the generated Docker manifest:

```bash
mkdir -p ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef
curl -k https://localhost/manifest.prod.xml \
  -o ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/a1b2c3d4-e5f6-7890-abcd-ef1234567890.manifest.xml
```

Fully quit and reopen Excel. This validates the production container,
production manifest generation, hosted taskpane, and first-run company gateway
bootstrap.

## 3. Give users the manifest

Send users:

```text
https://pi-excel.internal.test/manifest.prod.xml
```

On macOS, sideload by copying the downloaded manifest to:

```text
~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

Then fully quit and reopen Excel. The first opened taskpane should already use
the company model, so users do not need `/settings` for the pilot.

## TLS note

Office add-ins require HTTPS. For internal hostnames either:

- run Caddy on `:8080` and terminate HTTPS in your existing internal reverse
  proxy, or
- mount a company-issued cert/key and set `CADDY_TLS_CERT_FILE` +
  `CADDY_TLS_KEY_FILE`, or
- set `CADDY_TLS_INTERNAL=1` for a quick pilot, then install/trust Caddy's
  internal root CA on tester machines.
