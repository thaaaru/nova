import { resolve } from "node:path";

import { isLlmProvider, type LlmSettings } from "../services/llm/provider.js";

export type NovaConfig = {
  databasePath: string;
  artifactsDirectory: string;
  headless: boolean;
  /**
   * Resolved model configuration, or undefined when no model is
   * configured at all. Every LLM-backed step (application
   * identification, test-case suggestion, plan generation) is skipped
   * when this is undefined — Nova degrades to its deterministic paths
   * rather than hard-failing a command for an operator without a key.
   * The API key is never logged, never written to disk, and never
   * included in an artifact.
   */
  llm?: LlmSettings;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Model configuration comes from NOVA_LLM_PROVIDER / NOVA_LLM_MODEL /
 * NOVA_LLM_BASE_URL / NOVA_LLM_API_KEY. DEEPSEEK_API_KEY is still
 * honoured on its own so every existing installation keeps working with
 * no change; it simply resolves to the deepseek provider.
 *
 * Nothing here hard-codes a vendor credential, and nothing defaults to a
 * paid hosted model unless the operator named one.
 */
function loadLlmSettings(): LlmSettings | undefined {
  const rawProvider = process.env.NOVA_LLM_PROVIDER?.trim();
  const apiKey = process.env.NOVA_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? undefined;
  const baseUrl = process.env.NOVA_LLM_BASE_URL?.trim() || undefined;
  const model = process.env.NOVA_LLM_MODEL?.trim() || process.env.NOVA_DEEPSEEK_MODEL?.trim();

  const provider = rawProvider && isLlmProvider(rawProvider) ? rawProvider : undefined;
  if (rawProvider && !provider) {
    throw new Error(
      `Unknown NOVA_LLM_PROVIDER "${rawProvider}". Expected one of: openai, deepseek, openai-compatible, ollama, self-hosted.`,
    );
  }

  // A local/self-hosted endpoint needs no key, so a base URL alone is
  // enough to enable the model paths; a hosted provider needs a key.
  if (!provider && !apiKey) {
    return undefined;
  }
  const resolvedProvider = provider ?? "deepseek";
  if (!apiKey && resolvedProvider !== "ollama" && resolvedProvider !== "self-hosted" && !baseUrl) {
    return undefined;
  }

  return {
    provider: resolvedProvider,
    model: model ?? defaultModelFor(resolvedProvider),
    baseUrl,
    apiKey,
    timeoutMs: positiveInt(process.env.NOVA_LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: positiveInt(process.env.NOVA_LLM_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    // Structured, low-variance generation is the only mode Nova uses.
    temperature: 0,
  };
}

function defaultModelFor(provider: LlmSettings["provider"]): string {
  switch (provider) {
    case "deepseek":
      return "deepseek-chat";
    case "openai":
      return "gpt-4o-mini";
    default:
      // openai-compatible / ollama / self-hosted: the operator names the
      // model, because only they know what their endpoint serves.
      throw new Error(`NOVA_LLM_MODEL must be set for provider "${provider}".`);
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Central place every entrypoint (CLI, MCP server) reads config from — no scattered process.env reads elsewhere. */
export function loadConfig(overrides: Partial<NovaConfig> = {}): NovaConfig {
  return {
    databasePath: overrides.databasePath ?? resolve(process.env.NOVA_DATABASE_PATH ?? "data/nova.sqlite"),
    artifactsDirectory:
      overrides.artifactsDirectory ?? resolve(process.env.NOVA_ARTIFACTS_DIR ?? "artifacts"),
    headless: overrides.headless ?? process.env.NOVA_HEADLESS !== "false",
    llm: overrides.llm ?? loadLlmSettings(),
  };
}
