#!/usr/bin/env node
// Minimal static file server for the Pi for Excel add-in container.
//
// The container only serves the built taskpane plus the entrypoint-generated
// runtime-config.json / manifest.prod.xml over plain HTTP. TLS termination and
// the /llm-gateway reverse proxy live in the host Caddy (see deploy/Caddyfile.example).

import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.env.STATIC_ROOT || "/usr/share/app";
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

// Always-fresh files so config/manifest updates propagate immediately.
const NO_STORE = new Set(["/runtime-config.json", "/manifest.prod.xml"]);

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let rel = decoded === "/" ? "/index.html" : decoded;
  // Normalize and block path traversal outside ROOT.
  const full = path.normalize(path.join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    return null;
  }
  return full;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  const urlPath = req.url || "/";
  let filePath = resolveSafe(urlPath);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = await fs.stat(filePath);
    }

    const type = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    const normalized = "/" + path.relative(ROOT, filePath).split(path.sep).join("/");
    const headers = {
      "Content-Type": type,
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
    };
    if (NO_STORE.has(normalized)) {
      headers["Cache-Control"] = "no-store";
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[pi-for-excel] static server listening on http://${HOST}:${PORT} (root ${ROOT})`);
});
