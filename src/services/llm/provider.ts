import { ChatOpenAI } from "@langchain/openai";

/**
 * Nova's single, provider-neutral model factory. Every LangChain chain in
 * the product is constructed from here so that model choice, base URL,
 * timeout, retry budget, and temperature are configuration, never
 * hard-coded at a call site, and so an operator can point Nova at a
 * hosted provider, an OpenAI-compatible gateway, a self-hosted
 * enterprise endpoint, or a local model without a code change.
 *
 * Every supported provider speaks the OpenAI chat-completions wire
 * format, which is why one client class covers all of them — adding a
 * genuinely different protocol would mean a second branch here, not a
 * second abstraction layer.
 */
export const LLM_PROVIDERS = ["openai", "deepseek", "openai-compatible", "ollama", "self-hosted"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  /** Required for openai-compatible/self-hosted; defaulted for the named providers. */
  baseUrl?: string;
  /** Never logged, never persisted, never written into an artifact. */
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
};

const DEFAULT_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  deepseek: "https://api.deepseek.com",
  ollama: "http://127.0.0.1:11434/v1",
};

export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolves the base URL a provider should talk to, or throws when a
 * provider that has no sensible default was configured without one —
 * failing at construction beats a confusing 404 mid-discovery.
 */
export function resolveBaseUrl(settings: LlmSettings): string | undefined {
  if (settings.baseUrl && settings.baseUrl.trim().length > 0) {
    return settings.baseUrl.trim();
  }
  const fallback = DEFAULT_BASE_URLS[settings.provider];
  if (fallback) {
    return fallback;
  }
  if (settings.provider === "openai") {
    return undefined; // the SDK's own default
  }
  throw new Error(
    `NOVA_LLM_PROVIDER="${settings.provider}" requires NOVA_LLM_BASE_URL to be set (no default endpoint exists for it).`,
  );
}

/**
 * Local endpoints (ollama and most self-hosted gateways) accept any
 * non-empty key; the OpenAI SDK refuses to construct without one. This
 * placeholder is never a credential and is only used where the endpoint
 * itself does not authenticate.
 */
const LOCAL_PLACEHOLDER_KEY = "nova-local";

export function createChatModel(settings: LlmSettings): ChatOpenAI {
  const baseURL = resolveBaseUrl(settings);
  return new ChatOpenAI({
    apiKey: settings.apiKey && settings.apiKey.length > 0 ? settings.apiKey : LOCAL_PLACEHOLDER_KEY,
    model: settings.model,
    temperature: settings.temperature,
    timeout: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}
