import type { DiscoverySnapshot } from "../../domain/index.js";
import type { GraphState } from "../state.js";

export type DiscoverDependencies = {
  discover: (options: {
    runId: string;
    manifest: GraphState["run"]["targetManifest"];
    headless?: boolean;
    onProgress?: (message: string) => void;
  }) => Promise<DiscoverySnapshot>;
  headless?: boolean;
  /** Forwarded verbatim into every `discover()` call; wired to stderr only by CLI call sites that want live progress (nova discover/map discover) — TUI/MCP leave it unset. */
  onProgress?: (message: string) => void;
};

/**
 * Node 1: discover. Launches Playwright against the approved manifest,
 * captures a shallow read-only application map, and persists it into
 * run state. Never clicks, fills, or submits anything.
 */
export function createDiscoverNode(deps: DiscoverDependencies) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    const snapshot = await deps.discover({
      runId: run.runId,
      manifest: run.targetManifest,
      headless: deps.headless,
      onProgress: deps.onProgress,
    });

    return {
      run: {
        ...run,
        discoverySnapshot: snapshot,
        status: "planning",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "discovery_completed",
            detail: { pageCount: snapshot.pages.length, visitedUrlCount: snapshot.visitedUrls.length },
            actor: "system",
          },
        ],
      },
    };
  };
}
