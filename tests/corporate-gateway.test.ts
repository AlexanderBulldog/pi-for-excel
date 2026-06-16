import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeCorporateGatewayConfig } from "../src/config/corporate-gateway.ts";

void test("normalizeCorporateGatewayConfig returns null when disabled or incomplete", () => {
  assert.equal(normalizeCorporateGatewayConfig(undefined), null);
  assert.equal(normalizeCorporateGatewayConfig({ corporateGateway: { enabled: false } }), null);
  assert.equal(
    normalizeCorporateGatewayConfig({ corporateGateway: { endpointUrl: "https://llm.example.com/v1" } }),
    null,
  );
});

void test("normalizeCorporateGatewayConfig trims valid runtime gateway settings", () => {
  const normalized = normalizeCorporateGatewayConfig({
    corporateGateway: {
      displayName: " Company ",
      endpointUrl: " https://llm.example.com/v1 ",
      modelId: " model-a ",
      apiKey: " key ",
      contextWindow: "65536",
    },
  });

  assert.deepEqual(normalized, {
    displayName: "Company",
    endpointUrl: "https://llm.example.com/v1",
    modelId: "model-a",
    apiKey: "key",
    contextWindow: 65_536,
  });
});
