/**
 * Runtime bootstrap for company-hosted OpenAI-compatible gateways.
 *
 * Docker deployments can expose /runtime-config.json so first-run users get a
 * ready-to-use model without opening /settings.
 */

import type { CustomProvidersStoreLike, SaveOpenAiGatewayInput } from "../auth/custom-gateways.js";
import {
  listOpenAiGatewayConfigs,
  saveOpenAiGatewayConfig,
} from "../auth/custom-gateways.js";

const RUNTIME_CONFIG_URL = "/runtime-config.json";

interface RuntimeCorporateGatewayConfig {
  enabled?: unknown;
  displayName?: unknown;
  endpointUrl?: unknown;
  modelId?: unknown;
  apiKey?: unknown;
  contextWindow?: unknown;
}

interface RuntimeConfig {
  corporateGateway?: RuntimeCorporateGatewayConfig;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalPositiveInteger(value: unknown): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function normalizeCorporateGatewayConfig(
  config: RuntimeConfig | null | undefined,
): SaveOpenAiGatewayInput | null {
  const gateway = config?.corporateGateway;
  if (!gateway || gateway.enabled === false) {
    return null;
  }

  const endpointUrl = asTrimmedString(gateway.endpointUrl);
  const modelId = asTrimmedString(gateway.modelId);

  if (!endpointUrl || !modelId) {
    return null;
  }

  return {
    displayName: asTrimmedString(gateway.displayName) || "Company LLM",
    endpointUrl,
    modelId,
    apiKey: asTrimmedString(gateway.apiKey),
    contextWindow: asOptionalPositiveInteger(gateway.contextWindow),
  };
}

async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  let response: Response;
  try {
    response = await fetch(RUNTIME_CONFIG_URL, { cache: "no-store" });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  try {
    return await response.json() as RuntimeConfig;
  } catch {
    return null;
  }
}

export async function ensureCorporateGatewayConfigured(
  customProvidersStore: CustomProvidersStoreLike,
): Promise<void> {
  const input = normalizeCorporateGatewayConfig(await fetchRuntimeConfig());
  if (!input) {
    return;
  }

  const existing = await listOpenAiGatewayConfigs(customProvidersStore);
  const match = existing.find((gateway) => (
    gateway.displayName === input.displayName
    || (
      gateway.endpointUrl === input.endpointUrl
      && gateway.modelId === input.modelId
    )
  ));

  await saveOpenAiGatewayConfig(customProvidersStore, {
    ...input,
    id: match?.id,
  });
}
