# Lead rollout checklist

This is the shortest path for a lead to take this repo, deploy it internally,
and onboard a small Excel test group.

## 0. What this deploy provides

- One hosted Office add-in URL.
- One manifest URL for Excel users.
- One preconfigured company OpenAI-compatible LLM.
- No per-user API key setup.

Users should only install/open the add-in and start chatting.

## 1. Create the GitLab project

Create an empty project in GitLab, then push this repo:

```bash
git remote add gitlab https://gitlab.yakov.partners/<group>/<project>.git
git push -u gitlab HEAD:main
```

Do not commit `.env`; it contains deployment secrets and is gitignored.

## 2. Fill server `.env`

On the deploy server, copy `.env.example` to `.env` and set:

```bash
ADDIN_BASE_URL=https://pi-excel.<company-domain>
ADDIN_SITE_ADDRESS=:8080

OPENAI_BASE_URL=https://<company-llm-host>/v1
LLM_MODEL=<model-id>
OPENAI_API_KEY=<gateway-key-if-required>

CORPORATE_GATEWAY_PROXY=1
CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY=1
CORPORATE_GATEWAY_CONTEXT_WINDOW=65536
CORPORATE_GATEWAY_NAME=Company LLM
```

For a hardened deployment, install the company CA in the container and set:

```bash
CORPORATE_GATEWAY_TLS_INSECURE_SKIP_VERIFY=0
```

For the pilot, `1` is acceptable when the internal LLM endpoint uses a
self-signed or company CA certificate that the container does not trust yet.

## 3. Configure HTTPS

Office add-ins require HTTPS.

Recommended: terminate HTTPS in the existing internal reverse proxy, then send
traffic to this container on `:8080`.

The externally visible URL must match:

```bash
ADDIN_BASE_URL=https://pi-excel.<company-domain>
```

## 4. Start the app

```bash
docker compose up -d --build
```

Check:

```bash
curl -k "$ADDIN_BASE_URL/manifest.prod.xml"
curl -k "$ADDIN_BASE_URL/runtime-config.json"
curl -k "$ADDIN_BASE_URL/llm-gateway/v1/models"
```

Expected:

- `manifest.prod.xml` references `ADDIN_BASE_URL`.
- `runtime-config.json` references `ADDIN_BASE_URL/llm-gateway/v1`.
- `runtime-config.json` does not expose the real upstream key.
- `/llm-gateway/v1/models` returns the configured model.

The add-in may store a placeholder key `proxied-by-docker`. That is expected:
the real upstream key is injected by Caddy server-side.

For a local end-to-end rehearsal before touching the real domain, run:

```bash
./scripts/create-localhost-cert.sh
npm run deploy:smoke
```

This starts the Docker build on `https://localhost`, validates the generated
manifest, validates `runtime-config.json`, and checks `/llm-gateway/v1/models`.

## 5. Onboard testers

Give testers this URL:

```text
https://pi-excel.<company-domain>/manifest.prod.xml
```

### macOS sideload

```bash
mkdir -p ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef
curl -k https://pi-excel.<company-domain>/manifest.prod.xml \
  -o ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/a1b2c3d4-e5f6-7890-abcd-ef1234567890.manifest.xml
```

Then fully quit and reopen Excel.

### Windows / Excel Web

Excel → Insert → Add-ins → Upload My Add-in → select `manifest.prod.xml`.

## 6. User acceptance test

In Excel, open Pi for Excel and send:

```text
Привет
```

Then:

```text
Write "hello from docker deploy" into cell A1
```

Pass criteria:

- The assistant responds through the company model.
- The add-in can read the workbook context.
- Cell `A1` is updated.

The yellow “Proxy not running” warning is about optional local/OAuth helper
features. It is not the Docker LLM gateway and can be ignored for this pilot.
