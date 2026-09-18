import { resolve } from "node:path";

export type NovaConfig = {
  databasePath: string;
  artifactsDirectory: string;
  headless: boolean;
};

/** Central place every entrypoint (CLI, MCP server) reads config from — no scattered process.env reads elsewhere. */
export function loadConfig(overrides: Partial<NovaConfig> = {}): NovaConfig {
  return {
    databasePath: overrides.databasePath ?? resolve(process.env.NOVA_DATABASE_PATH ?? "data/nova.sqlite"),
    artifactsDirectory:
      overrides.artifactsDirectory ?? resolve(process.env.NOVA_ARTIFACTS_DIR ?? "artifacts"),
    headless: overrides.headless ?? process.env.NOVA_HEADLESS !== "false",
  };
}
