import { resolve } from "node:path";

export type NovaConfig = {
  databasePath: string;
  artifactsDirectory: string;
  headless: boolean;
  /**
   * Set only when OPENAI_API_KEY is present in the environment. The plan
   * node's LLM path (services/llm/openai-plan-generator.ts) is skipped
   * entirely when this is undefined — Nova falls back to the deterministic
   * template planner, so no command hard-fails for an operator without a
   * key. Never logged, never written to disk, never passed to anything
   * outside the OpenAI client itself.
   */
  openaiApiKey?: string;
  openaiModel?: string;
};

/** Central place every entrypoint (CLI, MCP server) reads config from — no scattered process.env reads elsewhere. */
export function loadConfig(overrides: Partial<NovaConfig> = {}): NovaConfig {
  return {
    databasePath: overrides.databasePath ?? resolve(process.env.NOVA_DATABASE_PATH ?? "data/nova.sqlite"),
    artifactsDirectory:
      overrides.artifactsDirectory ?? resolve(process.env.NOVA_ARTIFACTS_DIR ?? "artifacts"),
    headless: overrides.headless ?? process.env.NOVA_HEADLESS !== "false",
    openaiApiKey: overrides.openaiApiKey ?? process.env.OPENAI_API_KEY ?? undefined,
    openaiModel: overrides.openaiModel ?? process.env.NOVA_OPENAI_MODEL ?? "gpt-4o-mini",
  };
}
