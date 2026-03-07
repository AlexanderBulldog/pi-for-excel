/**
 * local_filesystem — Experimental local filesystem bridge adapter.
 *
 * This tool stays registered for a stable tool list/prompt cache,
 * but execution is gated by:
 * - bridge URL override from /experimental fs-bridge-url (or default https://localhost:3342)
 * - reachable bridge health endpoint
 *
 * The local bridge contract (v1) is a POST JSON request to /v1/fs.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { validateOfficeProxyUrl } from "../auth/proxy-validation.js";
import { getErrorMessage } from "../utils/errors.js";
import { isRecord } from "../utils/type-guards.js";
import {
  extractBridgeErrorMessage,
  isAbortError,
  joinBridgeUrl,
  tryParseBridgeJson,
} from "./bridge-http-utils.js";

const FS_BRIDGE_API_PATH = "/v1/fs";
const DEFAULT_FS_BRIDGE_URL = "https://localhost:3342";
const DEFAULT_FS_BRIDGE_TIMEOUT_MS = 15_000;

export const FS_BRIDGE_URL_SETTING_KEY = "fs.bridge.url";
export const FS_BRIDGE_TOKEN_SETTING_KEY = "fs.bridge.token";

const FS_ACTIONS = [
  "list",
  "read",
  "stat",
  "search",
] as const;

type FsAction = (typeof FS_ACTIONS)[number];

const FS_ACTION_SET = new Set<string>(FS_ACTIONS);

function isFsAction(value: unknown): value is FsAction {
  return typeof value === "string" && FS_ACTION_SET.has(value);
}

function StringEnum<T extends string[]>(values: [...T], opts?: { description?: string }) {
  return Type.Union(
    values.map((value) => Type.Literal(value)),
    opts,
  );
}

const schema = Type.Object({
  action: StringEnum([...FS_ACTIONS], {
    description:
      "Filesystem operation. " +
      "list: directory listing. read: file content. stat: file metadata. search: find files by name pattern.",
  }),
  path: Type.Optional(Type.String({
    description:
      "Absolute path on the local filesystem. " +
      "Required for read and stat. For list, defaults to the first allowed root. " +
      "For search, the directory to search within.",
  })),
  pattern: Type.Optional(Type.String({
    description:
      "File name pattern for search action (e.g. \"*.xlsx\", \"report*.csv\"). " +
      "Uses simple glob matching with * and ? wildcards.",
  })),
  max_chars: Type.Optional(Type.Integer({
    minimum: 128,
    maximum: 200000,
    description: "Maximum characters to return for read output (default: 50000).",
  })),
  encoding: Type.Optional(Type.Union([
    Type.Literal("text"),
    Type.Literal("base64"),
  ], {
    description: "Read encoding: text (default) or base64 for binary files.",
  })),
  max_depth: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description: "Maximum directory depth for search (default: 3, max: 10).",
  })),
});

type Params = Static<typeof schema>;

export interface FsBridgeConfig {
  url: string;
  token?: string;
}

export interface FsBridgeRequest {
  action: FsAction;
  path?: string;
  pattern?: string;
  max_chars?: number;
  encoding?: string;
  max_depth?: number;
}

export interface FsBridgeResponse {
  ok: boolean;
  action: FsAction;
  path?: string;
  entries?: Array<{
    path: string;
    name: string;
    type: string;
    size: number;
    modified_at?: string;
    created_at?: string;
  }>;
  content?: string;
  encoding?: string;
  size?: number;
  truncated?: boolean;
  exists?: boolean;
  type?: string;
  modified_at?: string;
  created_at?: string;
  pattern?: string;
  matches?: Array<{
    path: string;
    name: string;
    type: string;
    size: number;
  }>;
  error?: string;
}

export interface LocalFilesystemToolDetails {
  kind: "fs_bridge";
  ok: boolean;
  action: FsAction;
  bridgeUrl?: string;
  path?: string;
  entriesCount?: number;
  fileSize?: number;
  error?: string;
  gateReason?: "missing_bridge_url" | "invalid_bridge_url" | "bridge_unreachable";
  skillHint?: string;
}

export interface LocalFilesystemToolDependencies {
  getBridgeConfig?: () => Promise<FsBridgeConfig | null>;
  callBridge?: (
    request: FsBridgeRequest,
    config: FsBridgeConfig,
    signal: AbortSignal | undefined,
  ) => Promise<FsBridgeResponse>;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value;
}

function parseParams(raw: unknown): Params {
  if (!isRecord(raw)) {
    throw new Error("Invalid local_filesystem params: expected an object.");
  }

  if (!isFsAction(raw.action)) {
    throw new Error("Invalid filesystem action.");
  }

  const params: Params = {
    action: raw.action,
  };

  if (typeof raw.path === "string") params.path = raw.path;
  if (typeof raw.pattern === "string") params.pattern = raw.pattern;
  if (typeof raw.encoding === "string") params.encoding = raw.encoding as "text" | "base64";

  const maxChars = toOptionalInteger(raw.max_chars);
  if (maxChars !== undefined) params.max_chars = maxChars;

  const maxDepth = toOptionalInteger(raw.max_depth);
  if (maxDepth !== undefined) params.max_depth = maxDepth;

  return params;
}

function validateActionParams(params: Params): void {
  switch (params.action) {
    case "list":
      return;

    case "read":
    case "stat": {
      const pathValue = cleanOptionalString(params.path);
      if (!pathValue) {
        throw new Error(`path is required for ${params.action}`);
      }
      return;
    }

    case "search":
      return;
  }
}

function toBridgeRequest(params: Params): FsBridgeRequest {
  return {
    action: params.action,
    path: cleanOptionalString(params.path),
    pattern: cleanOptionalString(params.pattern),
    max_chars: params.max_chars,
    encoding: params.encoding,
    max_depth: params.max_depth,
  };
}

function parseBridgeResponse(value: unknown, fallbackAction: FsAction): FsBridgeResponse {
  if (!isRecord(value)) {
    return {
      ok: true,
      action: fallbackAction,
    };
  }

  const action = isFsAction(value.action) ? value.action : fallbackAction;
  const ok = typeof value.ok === "boolean" ? value.ok : true;

  return {
    ok,
    action,
    path: typeof value.path === "string" ? value.path : undefined,
    entries: Array.isArray(value.entries) ? value.entries as FsBridgeResponse["entries"] : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    encoding: typeof value.encoding === "string" ? value.encoding : undefined,
    size: typeof value.size === "number" ? value.size : undefined,
    truncated: typeof value.truncated === "boolean" ? value.truncated : undefined,
    exists: typeof value.exists === "boolean" ? value.exists : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
    modified_at: typeof value.modified_at === "string" ? value.modified_at : undefined,
    created_at: typeof value.created_at === "string" ? value.created_at : undefined,
    pattern: typeof value.pattern === "string" ? value.pattern : undefined,
    matches: Array.isArray(value.matches) ? value.matches as FsBridgeResponse["matches"] : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

async function defaultGetBridgeConfig(): Promise<FsBridgeConfig | null> {
  let rawUrl = DEFAULT_FS_BRIDGE_URL;
  let token: string | undefined;

  try {
    const storageModule = await import("@mariozechner/pi-web-ui/dist/storage/app-storage.js");
    const settings = storageModule.getAppStorage().settings;

    const urlValue = await settings.get<string>(FS_BRIDGE_URL_SETTING_KEY);
    const configuredUrl = typeof urlValue === "string" ? urlValue.trim() : "";
    if (configuredUrl.length > 0) {
      rawUrl = configuredUrl;
    }

    const tokenValue = await settings.get<string>(FS_BRIDGE_TOKEN_SETTING_KEY);
    token = typeof tokenValue === "string" && tokenValue.trim().length > 0
      ? tokenValue.trim()
      : undefined;
  } catch {
    // Fall back to default localhost URL when settings are unavailable.
  }

  try {
    const normalizedUrl = validateOfficeProxyUrl(rawUrl);
    return {
      url: normalizedUrl,
      token,
    };
  } catch {
    return null;
  }
}

async function defaultCallBridge(
  request: FsBridgeRequest,
  config: FsBridgeConfig,
  signal: AbortSignal | undefined,
): Promise<FsBridgeResponse> {
  const endpoint = joinBridgeUrl(config.url, FS_BRIDGE_API_PATH);
  const controller = new AbortController();
  const timeoutMs = DEFAULT_FS_BRIDGE_TIMEOUT_MS;

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abortFromCaller = () => {
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    const parsedBody = tryParseBridgeJson(rawBody);

    if (!response.ok) {
      const payloadError = extractBridgeErrorMessage(parsedBody);
      const textError = rawBody.trim().length > 0 ? rawBody.trim() : null;
      const reason = payloadError ?? textError ?? `HTTP ${response.status}`;
      throw new Error(`Filesystem bridge request failed (${response.status}): ${reason}`);
    }

    if (parsedBody === null) {
      return {
        ok: true,
        action: request.action,
      };
    }

    const parsed = parseBridgeResponse(parsedBody, request.action);
    if (!parsed.ok) {
      throw new Error(parsed.error ?? "Filesystem bridge rejected the request.");
    }

    return parsed;
  } catch (error: unknown) {
    if (isAbortError(error)) {
      if (signal?.aborted) {
        throw new Error("Aborted");
      }
      throw new Error(`Filesystem bridge request timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBridgeSuccessText(
  request: FsBridgeRequest,
  response: FsBridgeResponse,
): string {
  switch (request.action) {
    case "list": {
      const entries = response.entries ?? [];
      if (entries.length === 0) {
        return `Directory listing for **${response.path ?? request.path}**: _empty directory._`;
      }

      const lines = [`Directory listing for **${response.path ?? request.path}** (${entries.length} entries):`, ""];
      for (const entry of entries) {
        const suffix = entry.type === "directory" ? "/" : ` (${formatBytes(entry.size)})`;
        lines.push(`- ${entry.name}${suffix}`);
      }

      return lines.join("\n");
    }

    case "read": {
      const content = response.content ?? "";
      const size = response.size ?? content.length;
      const truncatedNote = response.truncated ? "\n\n_Output was truncated. Increase max_chars to read more._" : "";
      const encodingNote = response.encoding === "base64" ? "\n_(base64 encoded)_" : "";

      return `Read **${response.path ?? request.path}** (${formatBytes(size)}):\n\n\`\`\`\n${content}\n\`\`\`${truncatedNote}${encodingNote}`;
    }

    case "stat": {
      if (response.exists === false) {
        return `**${response.path ?? request.path}**: does not exist.`;
      }

      const lines = [`**${response.path ?? request.path}**:`];
      if (response.type) lines.push(`- Type: ${response.type}`);
      if (response.size !== undefined) lines.push(`- Size: ${formatBytes(response.size)}`);
      if (response.modified_at) lines.push(`- Modified: ${response.modified_at}`);
      if (response.created_at) lines.push(`- Created: ${response.created_at}`);

      return lines.join("\n");
    }

    case "search": {
      const matches = response.matches ?? [];
      if (matches.length === 0) {
        return `No files matching **${response.pattern ?? request.pattern ?? "*"}** found in ${response.path ?? request.path}.`;
      }

      const truncatedNote = response.truncated ? " (results truncated)" : "";
      const lines = [`Found ${matches.length} files matching **${response.pattern ?? request.pattern ?? "*"}** in ${response.path ?? request.path}${truncatedNote}:`, ""];
      for (const match of matches) {
        lines.push(`- ${match.path} (${formatBytes(match.size)})`);
      }

      return lines.join("\n");
    }
  }
}

function buildMissingBridgeConfigurationMessage(): string {
  return (
    "Filesystem bridge URL is unavailable. " +
    "By default Pi uses https://localhost:3342; set /experimental fs-bridge-url <url> to override it."
  );
}

function withSkillHintLine(message: string, skillName: string): string {
  return `${message}\nSkill: ${skillName}`;
}

function shouldAttachFsBridgeSkillHint(message: string): boolean {
  const normalized = message.toLowerCase();

  return normalized.includes("filesystem bridge")
    || normalized.includes("fs-bridge-url")
    || normalized.includes("bridge url")
    || normalized.includes("missing_bridge_url")
    || normalized.includes("bridge unavailable")
    || normalized.includes("bridge request")
    || normalized.includes("failed to fetch")
    || normalized.includes("fetch failed")
    || normalized.includes("network request failed")
    || normalized.includes("econnrefused");
}

export function createLocalFilesystemTool(
  dependencies: LocalFilesystemToolDependencies = {},
): AgentTool<TSchema, LocalFilesystemToolDetails> {
  const getBridgeConfig = dependencies.getBridgeConfig ?? defaultGetBridgeConfig;
  const callBridge = dependencies.callBridge ?? defaultCallBridge;

  return {
    name: "local_filesystem",
    label: "Local Filesystem",
    description:
      "Read-only access to the local filesystem via a bridge. " +
      "Actions: list directory contents, read file content, stat file metadata, search for files by name pattern. " +
      "Use this to access local Excel files, CSV data, and other files on the user's machine without manual upload.",
    parameters: schema,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<LocalFilesystemToolDetails>> => {
      let params: Params | null = null;

      try {
        params = parseParams(rawParams);
        validateActionParams(params);

        const bridgeConfig = await getBridgeConfig();
        if (!bridgeConfig) {
          return {
            content: [{
              type: "text",
              text: withSkillHintLine(buildMissingBridgeConfigurationMessage(), "filesystem-bridge"),
            }],
            details: {
              kind: "fs_bridge",
              ok: false,
              action: params.action,
              error: "missing_bridge_url",
              gateReason: "missing_bridge_url",
              skillHint: "filesystem-bridge",
            },
          };
        }

        const request = toBridgeRequest(params);
        const response = await callBridge(request, bridgeConfig, signal);

        if (!response.ok) {
          throw new Error(response.error ?? "Filesystem bridge rejected the request.");
        }

        return {
          content: [{ type: "text", text: formatBridgeSuccessText(request, response) }],
          details: {
            kind: "fs_bridge",
            ok: true,
            action: request.action,
            bridgeUrl: bridgeConfig.url,
            path: response.path ?? request.path,
            entriesCount: response.entries?.length ?? response.matches?.length,
            fileSize: response.size,
          },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        const fallbackAction =
          params?.action ??
          (isRecord(rawParams) && isFsAction(rawParams.action)
            ? rawParams.action
            : "list");
        const skillHint = shouldAttachFsBridgeSkillHint(message)
          ? "filesystem-bridge"
          : undefined;

        return {
          content: [{
            type: "text",
            text: skillHint
              ? `Error: ${withSkillHintLine(message, skillHint)}`
              : `Error: ${message}`,
          }],
          details: {
            kind: "fs_bridge",
            ok: false,
            action: fallbackAction,
            error: message,
            skillHint,
          },
        };
      }
    },
  };
}
