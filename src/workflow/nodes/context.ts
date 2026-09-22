import type { DiscoverySnapshot, TestRunState } from "../../domain/index.js";
import type { GraphState } from "../state.js";

/**
 * The guided flow's first two nodes.
 *
 * `resolve_inputs` is a pure state transition: by the time the graph is
 * invoked, the CLI's own input resolution (src/cli/interactive) has
 * already produced a complete, validated manifest. This node records
 * that fact in the audit trail and moves the run into context discovery
 * — it never prompts, because a graph node has no terminal.
 *
 * `probe_entry_context` is the only node that decides whether
 * authentication is needed, and it decides it from a real observation
 * (an HTTP status, a redirect to a login-shaped path, or a sign-in form
 * on an otherwise-empty landing page), never from a model's opinion.
 */

export type AuthProbe = (options: {
  url: string;
  headless?: boolean;
}) => Promise<{ required: boolean; reason?: string }>;

export type ContextDependencies = {
  detectAuth: AuthProbe;
  discover: (options: {
    runId: string;
    manifest: TestRunState["targetManifest"];
    headless?: boolean;
    maxPages?: number;
    onProgress?: (message: string) => void;
  }) => Promise<DiscoverySnapshot>;
  headless?: boolean;
  /** Pages the shallow entry-context crawl may visit — deliberately tiny; the full crawl happens later. */
  entryContextPages?: number;
  onProgress?: (message: string) => void;
};

export function createResolveInputsNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    return {
      run: {
        ...run,
        status: "context_discovery",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "inputs_resolved",
            detail: {
              target: run.targetManifest.baseUrl,
              environment: run.targetManifest.environment,
              runExecutionMode: run.targetManifest.runExecutionMode,
              allowedDomains: run.targetManifest.allowedDomains,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}

export function createProbeEntryContextNode(deps: ContextDependencies) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;

    // Only ever asked once: once the operator has chosen a session, a
    // saved profile, or "public areas only", re-probing would loop the
    // graph back into the same question it already answered.
    if (!run.authenticationMode) {
      deps.onProgress?.("Checking whether sign-in is required...");
      const probe = await deps.detectAuth({
        url: run.targetManifest.baseUrl,
        headless: deps.headless,
      });
      if (probe.required && !run.targetManifest.storageStatePath) {
        return {
          run: {
            ...run,
            status: "authentication_required",
            authenticationReason: probe.reason,
            auditEvents: [
              ...run.auditEvents,
              {
                timestamp: new Date().toISOString(),
                type: "authentication_required",
                detail: { reason: probe.reason ?? "sign-in wall detected" },
                actor: "system",
              },
            ],
          },
        };
      }
      if (run.targetManifest.storageStatePath) {
        // A manifest that already carries a captured session needs no question.
        run.authenticationMode = "saved_profile";
      }
    }

    deps.onProgress?.("Reading the entry page...");
    const snapshot = await deps.discover({
      runId: run.runId,
      manifest: run.targetManifest,
      headless: deps.headless,
      maxPages: deps.entryContextPages ?? 2,
      onProgress: deps.onProgress,
    });

    return {
      run: {
        ...run,
        discoverySnapshot: snapshot,
        authenticationMode: run.authenticationMode ?? "not_required",
        status: "document_discovery",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "entry_context_captured",
            detail: {
              pageCount: snapshot.pages.length,
              authenticationMode: run.authenticationMode ?? "not_required",
            },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * Consumes the authentication choice the presentation layer made while
 * the graph was paused: a session captured through the existing secure
 * `nova login` path (recorded on the manifest as an opaque
 * storageStatePath), a reusable saved profile, or an explicit decision
 * to crawl public areas only. This node never handles a credential, a
 * cookie, or a token — only which of those three happened — and it
 * routes straight back to `probe_entry_context` so the entry context is
 * captured as the now-authenticated user.
 */
export function createEnsureAuthenticationNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    const mode =
      run.authenticationMode ?? (run.targetManifest.storageStatePath ? "browser_session" : undefined);
    if (!mode) {
      throw new Error(
        "ensure_authentication requires an authentication choice (session, saved profile, or public-only) before it runs.",
      );
    }
    return {
      run: {
        ...run,
        authenticationMode: mode,
        status: "authenticated",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "authentication_resolved",
            // Deliberately records the *mode* and nothing else: no path,
            // no cookie, no token, no username.
            detail: { authenticationMode: mode },
            actor: "operator",
          },
        ],
      },
    };
  };
}
