#!/usr/bin/env node

/**
 * Local filesystem bridge for Pi for Excel.
 *
 * Provides read-only filesystem access from the Excel add-in to a
 * user-specified directory on the local machine.
 *
 * Modes:
 * - stub (default): deterministic simulated responses for local development.
 * - real: reads actual files from the local filesystem within allowed roots.
 *
 * Endpoints:
 * - GET  /health
 * - POST /v1/fs
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

const args = new Set(process.argv.slice(2));
const useHttps = args.has("--https") || process.env.HTTPS === "1" || process.env.HTTPS === "true";
const useHttp = args.has("--http");

if (useHttps && useHttp) {
  console.error("[pi-for-excel] Invalid args: can't use both --https and --http");
  process.exit(1);
}

const HOST = process.env.HOST || (useHttps ? "localhost" : "127.0.0.1");
const PORT = Number.parseInt(process.env.PORT || "3342", 10);

const MODE_RAW = (process.env.FS_BRIDGE_MODE || "stub").trim().toLowerCase();
const MODE = MODE_RAW === "real" ? "real" : MODE_RAW === "stub" ? "stub" : null;
if (!MODE) {
  console.error(`[pi-for-excel] Invalid FS_BRIDGE_MODE: ${MODE_RAW}. Use "stub" or "real".`);
  process.exit(1);
}

function resolveOptionalEnvPath(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  return path.resolve(trimmed);
}

const certDir = resolveOptionalEnvPath("PI_FOR_EXCEL_CERT_DIR") ?? path.resolve(process.cwd());
const keyPath = resolveOptionalEnvPath("PI_FOR_EXCEL_KEY_PATH") ?? path.join(certDir, "key.pem");
const certPath = resolveOptionalEnvPath("PI_FOR_EXCEL_CERT_PATH") ?? path.join(certDir, "cert.pem");

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://localhost:3000",
  "https://pi-for-excel.vercel.app",
]);

const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_GLOB_RESULTS = 500;

const allowedOrigins = (() => {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;

  const custom = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return custom.size > 0 ? custom : DEFAULT_ALLOWED_ORIGINS;
})();

const authToken = (() => {
  const raw = process.env.FS_BRIDGE_TOKEN;
  if (typeof raw !== "string") return "";
  return raw.trim();
})();

/**
 * Allowed root directories. Only paths under these roots can be accessed.
 * Set via FS_BRIDGE_ROOTS env var (comma-separated absolute paths).
 * If not set, defaults to the user's home directory.
 */
const allowedRoots = (() => {
  const raw = process.env.FS_BRIDGE_ROOTS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const roots = raw
      .split(",")
      .map((value) => path.resolve(value.trim()))
      .filter((value) => value.length > 0);

    if (roots.length > 0) return roots;
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return [path.resolve(home)];

  console.error("[pi-for-excel] Cannot determine allowed roots. Set FS_BRIDGE_ROOTS.");
  process.exit(1);
})();

const FS_ACTIONS = [
  "list",
  "read",
  "stat",
  "search",
];
const FS_ACTION_SET = new Set(FS_ACTIONS);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedOrigin(origin) {
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  if (addr.startsWith("127.")) return true;
  if (addr.startsWith("::ffff:127.")) return true;
  return false;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "content-type,authorization",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function respondJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function respondText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function extractBearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return null;
  const token = headerValue.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(req) {
  if (!authToken) return true;

  const candidate = extractBearerToken(req.headers.authorization);
  if (!candidate) return false;

  return secureEquals(candidate, authToken);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += part.length;

    if (size > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, `Request body too large (max ${MAX_JSON_BODY_BYTES} bytes).`);
    }

    chunks.push(part);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    throw new HttpError(400, "Missing JSON request body.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate that a resolved path is within at least one allowed root.
 * This prevents directory traversal attacks.
 */
function validatePathWithinRoots(resolvedPath) {
  for (const root of allowedRoots) {
    // Ensure the resolved path starts with root + separator (or is the root itself)
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return root;
    }
  }

  throw new HttpError(
    403,
    `Path is outside allowed roots. Allowed roots: ${allowedRoots.join(", ")}`,
  );
}

/**
 * Resolve and validate a path from the request.
 */
function resolveAndValidatePath(rawPath) {
  const pathValue = normalizeOptionalString(rawPath);
  if (!pathValue) {
    throw new HttpError(400, "path is required.");
  }

  if (pathValue.length > MAX_PATH_LENGTH) {
    throw new HttpError(400, `path is too long (max ${MAX_PATH_LENGTH} characters).`);
  }

  if (!path.isAbsolute(pathValue)) {
    throw new HttpError(400, "path must be an absolute path.");
  }

  // Resolve to canonical form (handles .., symlinks in the path string)
  const resolved = path.resolve(pathValue);

  // Security: resolve any symlinks in the actual filesystem
  let realPath;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // If the path doesn't exist, just use resolved (stat will fail later)
    realPath = resolved;
  }

  validatePathWithinRoots(realPath);
  return realPath;
}

function parseFsRequest(payload) {
  if (!isRecord(payload)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  const action = normalizeOptionalString(payload.action);
  if (!action || !FS_ACTION_SET.has(action)) {
    throw new HttpError(400, `Invalid action. Must be one of: ${FS_ACTIONS.join(", ")}.`);
  }

  return {
    action,
    path: normalizeOptionalString(payload.path),
    pattern: normalizeOptionalString(payload.pattern),
    max_chars: typeof payload.max_chars === "number" ? payload.max_chars : undefined,
    encoding: normalizeOptionalString(payload.encoding),
    max_depth: typeof payload.max_depth === "number" ? payload.max_depth : undefined,
  };
}

function formatFileInfo(stats, filePath) {
  return {
    path: filePath,
    name: path.basename(filePath),
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other",
    size: stats.size,
    modified_at: stats.mtime.toISOString(),
    created_at: stats.birthtime.toISOString(),
  };
}

function createStubBackend() {
  return {
    mode: "stub",
    async health() {
      return {
        backend: "stub",
        roots: allowedRoots,
      };
    },
    async handle(request) {
      switch (request.action) {
        case "list": {
          return {
            ok: true,
            action: "list",
            path: request.path || allowedRoots[0],
            entries: [
              { path: path.join(request.path || allowedRoots[0], "example.xlsx"), name: "example.xlsx", type: "file", size: 12345, modified_at: "2025-01-01T00:00:00.000Z", created_at: "2025-01-01T00:00:00.000Z" },
              { path: path.join(request.path || allowedRoots[0], "data"), name: "data", type: "directory", size: 0, modified_at: "2025-01-01T00:00:00.000Z", created_at: "2025-01-01T00:00:00.000Z" },
            ],
          };
        }
        case "read": {
          return {
            ok: true,
            action: "read",
            path: request.path,
            content: "[stub] File content simulated.",
            size: 30,
            truncated: false,
          };
        }
        case "stat": {
          return {
            ok: true,
            action: "stat",
            path: request.path,
            exists: true,
            type: "file",
            size: 12345,
            modified_at: "2025-01-01T00:00:00.000Z",
            created_at: "2025-01-01T00:00:00.000Z",
          };
        }
        case "search": {
          return {
            ok: true,
            action: "search",
            path: request.path || allowedRoots[0],
            pattern: request.pattern || "*.xlsx",
            matches: [
              { path: path.join(request.path || allowedRoots[0], "example.xlsx"), name: "example.xlsx", type: "file", size: 12345 },
            ],
          };
        }
        default:
          throw new HttpError(400, "Invalid action.");
      }
    },
  };
}

/**
 * Recursively collect files matching a glob-like pattern within a directory.
 * Supports simple patterns: *.ext, name.*, *.* (all files).
 */
function searchFiles(dirPath, pattern, maxDepth, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  // Convert glob pattern to a regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`, "i");

  for (const entry of entries) {
    if (results.length >= MAX_GLOB_RESULTS) break;

    const entryPath = path.join(dirPath, entry.name);

    // Skip hidden files/dirs (starting with .) and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isFile() && regex.test(entry.name)) {
      try {
        const stats = fs.statSync(entryPath);
        results.push({
          path: entryPath,
          name: entry.name,
          type: "file",
          size: stats.size,
        });
      } catch {
        // skip inaccessible files
      }
    }

    if (entry.isDirectory() && currentDepth < maxDepth) {
      results.push(...searchFiles(entryPath, pattern, maxDepth, currentDepth + 1));
    }
  }

  return results;
}

function createRealBackend() {
  return {
    mode: "real",
    async health() {
      return {
        backend: "real",
        roots: allowedRoots,
      };
    },
    async handle(request) {
      switch (request.action) {
        case "list": {
          const dirPath = resolveAndValidatePath(request.path || allowedRoots[0]);

          let stats;
          try {
            stats = fs.statSync(dirPath);
          } catch {
            throw new HttpError(404, `Path does not exist: ${dirPath}`);
          }

          if (!stats.isDirectory()) {
            throw new HttpError(400, `Path is not a directory: ${dirPath}`);
          }

          const rawEntries = fs.readdirSync(dirPath, { withFileTypes: true });
          const entries = [];

          for (const entry of rawEntries) {
            if (entries.length >= MAX_GLOB_RESULTS) break;

            const entryPath = path.join(dirPath, entry.name);
            try {
              const entryStats = fs.statSync(entryPath);
              entries.push(formatFileInfo(entryStats, entryPath));
            } catch {
              // skip inaccessible entries
            }
          }

          return {
            ok: true,
            action: "list",
            path: dirPath,
            entries,
          };
        }

        case "read": {
          const filePath = resolveAndValidatePath(request.path);

          let stats;
          try {
            stats = fs.statSync(filePath);
          } catch {
            throw new HttpError(404, `File does not exist: ${filePath}`);
          }

          if (!stats.isFile()) {
            throw new HttpError(400, `Path is not a file: ${filePath}`);
          }

          if (stats.size > MAX_READ_BYTES * 4) {
            throw new HttpError(413, `File is too large (${stats.size} bytes, max ${MAX_READ_BYTES * 4} bytes).`);
          }

          const maxChars = request.max_chars || 50000;
          const encoding = request.encoding === "base64" ? "base64" : "utf8";

          let content;
          if (encoding === "base64") {
            content = fs.readFileSync(filePath).toString("base64");
          } else {
            content = fs.readFileSync(filePath, "utf8");
          }

          let truncated = false;
          if (content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
          }

          return {
            ok: true,
            action: "read",
            path: filePath,
            content,
            encoding,
            size: stats.size,
            truncated,
          };
        }

        case "stat": {
          const targetPath = resolveAndValidatePath(request.path);

          let stats;
          try {
            stats = fs.statSync(targetPath);
          } catch {
            return {
              ok: true,
              action: "stat",
              path: targetPath,
              exists: false,
            };
          }

          return {
            ok: true,
            action: "stat",
            ...formatFileInfo(stats, targetPath),
            exists: true,
          };
        }

        case "search": {
          const searchPath = resolveAndValidatePath(request.path || allowedRoots[0]);
          const pattern = request.pattern || "*";
          const maxDepth = Math.min(request.max_depth || 3, 10);

          const matches = searchFiles(searchPath, pattern, maxDepth);

          return {
            ok: true,
            action: "search",
            path: searchPath,
            pattern,
            max_depth: maxDepth,
            matches: matches.slice(0, MAX_GLOB_RESULTS),
            truncated: matches.length > MAX_GLOB_RESULTS,
          };
        }

        default:
          throw new HttpError(400, "Invalid action.");
      }
    },
  };
}

const backend = MODE === "real" ? createRealBackend() : createStubBackend();

const handler = async (req, res) => {
  try {
    const remote = req.socket?.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      respondText(res, 403, "forbidden");
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      respondText(res, 403, "forbidden");
      return;
    }

    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const rawUrl = req.url || "/";
    const url = new URL(rawUrl, `http://${HOST}:${PORT}`);

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        throw new HttpError(405, "Method not allowed.");
      }

      respondJson(res, 200, {
        ok: true,
        mode: backend.mode,
        ...await backend.health(),
      });
      return;
    }

    if (url.pathname === "/v1/fs") {
      if (req.method !== "POST") {
        throw new HttpError(405, "Method not allowed.");
      }

      if (!isAuthorized(req)) {
        throw new HttpError(401, "Unauthorized.");
      }

      const payload = await readJsonBody(req);
      const request = parseFsRequest(payload);
      const result = await backend.handle(request);

      respondJson(res, 200, {
        ok: true,
        ...result,
      });
      return;
    }

    throw new HttpError(404, "Not found.");
  } catch (error) {
    const isHttpError = error instanceof HttpError;
    const status = isHttpError ? error.status : 500;

    if (!isHttpError) {
      console.error("[pi-for-excel] Unhandled filesystem bridge error:", error);
    }

    const message = isHttpError
      ? error.message
      : "Internal server error.";

    respondJson(res, status, {
      ok: false,
      error: message,
    });
  }
};

const server = (() => {
  if (!useHttps) {
    return http.createServer(handler);
  }

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error("[pi-for-excel] HTTPS requested but key.pem/cert.pem not found in repo root.");
    console.error("Generate them with mkcert (see README). Example: mkcert localhost");
    process.exit(1);
  }

  return https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    handler,
  );
})();

server.listen(PORT, HOST, () => {
  const scheme = useHttps ? "https" : "http";
  console.log(`[pi-for-excel] filesystem bridge listening on ${scheme}://${HOST}:${PORT}`);
  console.log(`[pi-for-excel] mode: ${backend.mode}`);
  console.log(`[pi-for-excel] health: ${scheme}://${HOST}:${PORT}/health`);
  console.log(`[pi-for-excel] endpoint: ${scheme}://${HOST}:${PORT}/v1/fs`);
  console.log(`[pi-for-excel] allowed origins: ${Array.from(allowedOrigins).join(", ")}`);
  console.log(`[pi-for-excel] allowed roots: ${allowedRoots.join(", ")}`);

  if (authToken) {
    console.log("[pi-for-excel] auth: bearer token required for POST /v1/fs");
  }

  if (backend.mode === "stub") {
    console.log("[pi-for-excel] stub mode: filesystem calls are simulated.");
    console.log("[pi-for-excel] use FS_BRIDGE_MODE=real for local filesystem access.");
  }
});
