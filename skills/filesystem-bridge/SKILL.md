---
name: filesystem-bridge
description: Read-only local filesystem access via the filesystem bridge. Use when the user wants to browse, read, or search for files on their local machine without manual upload.
compatibility: Requires a local filesystem bridge process running on the user's machine.
metadata:
  tool-name: local_filesystem
---

# Filesystem Bridge

The filesystem bridge gives Pi read-only access to files on the user's local machine. The `local_filesystem` tool is always registered — it just needs the bridge process running locally to work.

## What it does

When the bridge is running, the `local_filesystem` tool can:
- **list** — list files and directories at a given path
- **read** — read the content of a file (text or base64)
- **stat** — get metadata about a file (size, type, timestamps)
- **search** — find files matching a name pattern (e.g. `*.xlsx`, `report*.csv`)

## Common use cases

- Reading local Excel/CSV files the user references in conversation
- Browsing a project directory to find relevant data files
- Searching for files by extension or name pattern
- Reading configuration files, logs, or data exports

## How to set it up

### 1. Start the bridge

The bridge is a local HTTPS server. Run it from the pi-for-excel directory:

```bash
# From the repo directory:
npm run fs:bridge:https

# Or with custom allowed roots:
FS_BRIDGE_ROOTS=/Users/me/Documents,/Users/me/Desktop FS_BRIDGE_MODE=real npm run fs:bridge:https
```

This defaults to **real mode** on `https://localhost:3342`.

Environment variables:
- `FS_BRIDGE_MODE=real` — access real files (default: stub)
- `FS_BRIDGE_ROOTS=/path/a,/path/b` — comma-separated allowed directories (default: home directory)
- `FS_BRIDGE_TOKEN=your-secret` — require auth token
- `PORT=3342` — bridge port (default: 3342)

### 2. Configure in Pi (usually not needed)

The default bridge URL (`https://localhost:3342`) works automatically. If you need a custom URL or auth token:

```
/experimental fs-bridge-url <url>
/experimental fs-bridge-token <token>
```

### 3. Accept the local HTTPS certificate

The bridge uses a self-signed cert. You may need to visit `https://localhost:3342` in your browser once and accept it.

## Security

- **Read-only** — the bridge cannot write, delete, or modify files
- **Root restrictions** — only paths under configured `FS_BRIDGE_ROOTS` are accessible
- **Symlink traversal protection** — symlinks are resolved and checked against allowed roots
- **Loopback-only** — only accepts connections from localhost
- **Origin allowlist** — only the Pi for Excel app can make requests
- **Optional bearer token auth** — for additional security
- **Path validation** — rejects relative paths, path traversal attempts, and oversized paths

## Troubleshooting

- **"bridge URL is unavailable"** — the bridge process isn't running. Start it with `npm run fs:bridge:https`.
- **"Path is outside allowed roots"** — the requested path is not under any configured root. Check `FS_BRIDGE_ROOTS`.
- **"timed out"** — the bridge is running but the request took too long. Check if the file is very large.
- **CORS/cert errors** — visit the bridge URL directly in your browser and accept the certificate.
