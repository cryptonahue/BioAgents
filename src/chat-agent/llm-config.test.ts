/**
 * Offline tests for resolveLLM — the centralized provider/model resolver.
 *
 * resolveLLM reads process.env on every call and never throws or mutates state,
 * so each case manipulates the relevant env vars and restores them afterwards.
 * This locks in the security-relevant property that a missing key is reported as
 * keyConfigured=false (apiKey "") rather than silently leaking another
 * provider's key, plus the strict/auto selection contract.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveLLM } from "./llm-config";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "CHAT_AGENT_LLM_PROVIDER",
  "CHAT_AGENT_MODEL",
  "DEFAULT_ANTHROPIC_MODEL",
  "DEFAULT_OPENROUTER_MODEL",
  "DEFAULT_OPENAI_MODEL",
  "DEFAULT_GOOGLE_MODEL",
] as const;

const snapshot: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV) snapshot[k] = process.env[k];

function clearManaged() {
  for (const k of MANAGED_ENV) delete process.env[k];
}

afterEach(() => {
  for (const k of MANAGED_ENV) {
    const v = snapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveLLM", () => {
  it("strict miss: no key -> default provider, keyConfigured false", () => {
    clearManaged();
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic"],
      selection: "strict",
      defaultProvider: "anthropic",
    });
    expect(r.provider).toBe("anthropic");
    expect(r.keyConfigured).toBe(false);
    expect(r.apiKey).toBe("");
  });

  it("strict hit: configured key -> provider used with its key", () => {
    clearManaged();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic"],
      selection: "strict",
      defaultProvider: "anthropic",
    });
    expect(r.provider).toBe("anthropic");
    expect(r.keyConfigured).toBe(true);
    expect(r.apiKey).toBe("sk-ant-test");
  });

  it("strict honors an allowed provider hint", () => {
    clearManaged();
    process.env.CHAT_AGENT_LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "or-test";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic", "openrouter"],
      selection: "strict",
      defaultProvider: "anthropic",
    });
    expect(r.provider).toBe("openrouter");
    expect(r.apiKey).toBe("or-test");
  });

  it("strict with an unknown hint falls back to the default provider", () => {
    clearManaged();
    process.env.CHAT_AGENT_LLM_PROVIDER = "not-a-provider";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic", "openai"],
      selection: "strict",
      defaultProvider: "openai",
    });
    expect(r.provider).toBe("openai");
    expect(r.keyConfigured).toBe(false);
  });

  it("model override via env wins over the provider default model", () => {
    clearManaged();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.CHAT_AGENT_MODEL = "custom-model-x";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      modelEnv: ["CHAT_AGENT_MODEL"],
      allowed: ["anthropic"],
      selection: "strict",
      defaultProvider: "anthropic",
    });
    expect(r.model).toBe("custom-model-x");
  });

  it("auto: hinted provider key missing -> falls back to first allowed with a key", () => {
    clearManaged();
    process.env.CHAT_AGENT_LLM_PROVIDER = "anthropic"; // hint, but no anthropic key
    process.env.OPENAI_API_KEY = "oa-test";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic", "openai"],
      selection: "auto",
      defaultProvider: "anthropic",
    });
    expect(r.provider).toBe("openai");
    expect(r.apiKey).toBe("oa-test");
    expect(r.keyConfigured).toBe(true);
  });

  it("auto: honors the hint when the hinted provider's key is present", () => {
    clearManaged();
    process.env.CHAT_AGENT_LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "oa-test";
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic", "openai"],
      selection: "auto",
      defaultProvider: "openai",
    });
    expect(r.provider).toBe("anthropic");
    expect(r.apiKey).toBe("sk-ant-test");
  });

  it("auto: no keys anywhere -> default provider, keyConfigured false", () => {
    clearManaged();
    const r = resolveLLM({
      providerEnv: ["CHAT_AGENT_LLM_PROVIDER"],
      allowed: ["anthropic", "openai"],
      selection: "auto",
      defaultProvider: "google",
    });
    expect(r.provider).toBe("google");
    expect(r.keyConfigured).toBe(false);
    expect(r.apiKey).toBe("");
  });
});
