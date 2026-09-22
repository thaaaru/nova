import type { EvidenceSourceType, IdentificationArtifact } from "../../domain/index.js";
import type { DocumentEvidenceInput } from "../../services/llm/evidence.js";
import { buildEvidencePackage } from "../../services/llm/evidence.js";
import type { ApplicationIdentifier } from "../../services/llm/identify-application.js";
import {
  IDENTIFICATION_PROMPT_VERSION,
  degradedIdentification,
} from "../../services/llm/identify-application.js";
import type { IdentificationCache } from "../../services/llm/identification-cache.js";
import { identificationCacheKey } from "../../services/llm/identification-cache.js";
import type { GraphState } from "../state.js";

/**
 * Document discovery, evidence collection, LLM identification, human
 * confirmation, and reconciliation against the full crawl.
 *
 * The model appears in exactly one of these nodes, it receives only the
 * sanitized evidence package, and its answer is validated in code before
 * it is stored. Everything else here is deterministic.
 */

/** Evidence source types that came from a document rather than from a crawled page. */
const DOCUMENT_SOURCE_TYPES = new Set<EvidenceSourceType>([
  "documentation",
  "openapi",
  "sitemap",
  "help-page",
  "api-operation",
  "project-document",
  "confirmed-project-info",
]);

export type DocumentDependencies = {
  /** Omitted in tests and in offline runs; the flow then identifies from crawled pages alone. */
  discoverDocuments?: (options: {
    targetUrl: string;
    allowedDomains: string[];
    onProgress?: (message: string) => void;
  }) => Promise<DocumentEvidenceInput[]>;
  onProgress?: (message: string) => void;
};

export function createDiscoverDocumentsNode(deps: DocumentDependencies = {}) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    if (!run.discoverySnapshot) {
      throw new Error("discover_documents requires an entry-context snapshot before it runs.");
    }

    let documents: DocumentEvidenceInput[] = [];
    if (deps.discoverDocuments) {
      try {
        deps.onProgress?.("Looking for published documentation...");
        documents = await deps.discoverDocuments({
          targetUrl: run.targetManifest.baseUrl,
          allowedDomains: run.targetManifest.allowedDomains,
          onProgress: deps.onProgress,
        });
      } catch {
        // Documentation is a bonus signal, never a prerequisite.
        documents = [];
      }
    }

    const evidencePackage = buildEvidencePackage({
      runId: run.runId,
      snapshot: run.discoverySnapshot,
      documents,
      authenticationReason: run.authenticationReason,
    });

    return {
      run: {
        ...run,
        evidencePackage,
        status: "application_identification",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "documents_discovered",
            detail: { documentCount: documents.length },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * Rebuilds the evidence package from the snapshot Nova currently holds,
 * carrying forward any document evidence already found. Idempotent by
 * construction: the same snapshot and the same documents always produce
 * the same package and therefore the same evidence hash, which is what
 * makes the identification cache safe across a resume.
 */
export function createCollectEvidenceNode(options: { preserveStatus?: boolean } = {}) {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.discoverySnapshot) {
      throw new Error("collect_identification_evidence requires a discovery snapshot before it runs.");
    }
    const documents: DocumentEvidenceInput[] = (run.evidencePackage?.items ?? [])
      .filter((item) => DOCUMENT_SOURCE_TYPES.has(item.sourceType))
      .map((item) => ({
        sourceType: item.sourceType as DocumentEvidenceInput["sourceType"],
        source: item.source,
        content: item.content,
      }));

    const evidencePackage = buildEvidencePackage({
      runId: run.runId,
      snapshot: run.discoverySnapshot,
      documents,
      authenticationReason: run.authenticationReason,
    });

    return {
      run: {
        ...run,
        evidencePackage,
        // The post-discovery refresh keeps the run where it is: it is a
        // re-derivation of evidence, not a return to identification.
        status: options.preserveStatus ? run.status : "application_identification",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "identification_evidence_collected",
            detail: {
              itemCount: evidencePackage.items.length,
              redactedItemCount: evidencePackage.redactedItemCount,
              truncated: evidencePackage.truncated,
              evidenceHash: evidencePackage.evidenceHash,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}

export type IdentificationDependencies = {
  /** Omitted when no model is configured; the node then records an honest degraded artifact. */
  identify?: ApplicationIdentifier;
  cache?: IdentificationCache;
  provider?: string;
  model?: string;
  onProgress?: (message: string) => void;
};

export function createIdentifyApplicationNode(deps: IdentificationDependencies = {}) {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const run = state.run;
    const evidence = run.evidencePackage;
    if (!evidence) {
      throw new Error("identify_application_with_llm requires an evidence package before it runs.");
    }

    const provider = deps.provider ?? "none";
    const model = deps.model ?? "none";
    const cacheKey = identificationCacheKey({
      provider,
      model,
      promptVersion: IDENTIFICATION_PROMPT_VERSION,
      evidenceHash: evidence.evidenceHash,
    });

    // A resume, or a re-crawl that produced identical evidence, must not
    // pay for the same model call twice — and an already-confirmed
    // identification for this same evidence is never re-asked.
    const alreadyConfirmed =
      run.identification?.evidenceHash === evidence.evidenceHash && run.identification.confirmedBy;
    const cached = alreadyConfirmed ? run.identification : deps.cache?.get(cacheKey);
    if (cached) {
      return {
        run: {
          ...run,
          identification: cached,
          status: "identification_confirmation",
          auditEvents: [
            ...run.auditEvents,
            {
              timestamp: new Date().toISOString(),
              type: "application_identified",
              detail: { source: cached.source, cached: true, evidenceHash: evidence.evidenceHash },
              actor: "system",
            },
          ],
        },
      };
    }

    let artifact: IdentificationArtifact;
    if (!deps.identify) {
      artifact = degradedIdentification(
        evidence,
        "No model is configured (set NOVA_LLM_PROVIDER/NOVA_LLM_MODEL/NOVA_LLM_API_KEY).",
      );
    } else {
      try {
        deps.onProgress?.("Identifying the application from discovered evidence...");
        const result = await deps.identify(evidence);
        artifact = {
          version: (run.identification?.version ?? 0) + 1,
          identification: result.identification,
          evidenceHash: evidence.evidenceHash,
          provider,
          model,
          promptVersion: IDENTIFICATION_PROMPT_VERSION,
          producedAt: new Date().toISOString(),
          source: "llm",
          validationNotes: result.validationNotes,
        };
      } catch (error) {
        // Never fabricate a successful identification: record why it
        // failed and let the operator confirm or correct a zero-confidence
        // placeholder instead.
        artifact = degradedIdentification(evidence, error instanceof Error ? error.message : String(error), {
          provider: provider as never,
          model,
        });
      }
    }

    deps.cache?.set(cacheKey, artifact);
    return {
      run: {
        ...run,
        identification: artifact,
        status: "identification_confirmation",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "application_identified",
            detail: {
              source: artifact.source,
              provider: artifact.provider,
              model: artifact.model,
              promptVersion: artifact.promptVersion,
              evidenceHash: artifact.evidenceHash,
              confidence: artifact.identification.confidence,
              validationNotes: artifact.validationNotes,
            },
            actor: "system",
          },
        ],
      },
    };
  };
}

/**
 * The human gate on identification. The decision itself is made in the
 * TUI while the graph is paused; this node only validates that a real
 * confirmation is present and records it. An unconfirmed identification
 * can never reach discovery, suggestion, or approval.
 */
export function createConfirmIdentityNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.identification) {
      throw new Error("confirm_application_identity requires an identification artifact before it runs.");
    }
    if (!run.identification.confirmedBy) {
      throw new Error(
        "confirm_application_identity requires the identification to be confirmed by a person.",
      );
    }

    return {
      run: {
        ...run,
        status: "discovering",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "identification_confirmed",
            detail: {
              applicationName: run.identification.identification.applicationName,
              source: run.identification.source,
              version: run.identification.version,
            },
            actor: run.identification.confirmedBy,
          },
        ],
      },
    };
  };
}

/**
 * Re-checks the confirmed identification against the *full* crawl, which
 * has by now seen far more of the application than the entry context
 * did. Claims whose supporting evidence no longer exists in the
 * refreshed package are dropped rather than carried forward — the
 * Application Model must stay traceable to observations Nova can still
 * point at.
 */
export function createReconcileModelNode() {
  return (state: GraphState): Partial<GraphState> => {
    const run = state.run;
    if (!run.identification || !run.evidencePackage) {
      throw new Error("reconcile_application_model requires a confirmed identification and evidence.");
    }
    const known = new Set(run.evidencePackage.items.map((item) => item.evidenceId));
    const keep = <T extends { evidenceRefs: string[] }>(entries: T[]): T[] =>
      entries
        .map((entry) => ({ ...entry, evidenceRefs: entry.evidenceRefs.filter((ref) => known.has(ref)) }))
        .filter((entry) => entry.evidenceRefs.length > 0);

    const before = run.identification.identification;
    const after = {
      ...before,
      likelyPersonas: keep(before.likelyPersonas),
      coreEntities: keep(before.coreEntities),
      functionalAreas: keep(before.functionalAreas),
      likelyJourneys: keep(before.likelyJourneys),
      evidenceRefs: before.evidenceRefs.filter((ref) => known.has(ref)),
    };
    const droppedCount =
      before.likelyPersonas.length -
      after.likelyPersonas.length +
      (before.coreEntities.length - after.coreEntities.length) +
      (before.functionalAreas.length - after.functionalAreas.length) +
      (before.likelyJourneys.length - after.likelyJourneys.length);

    return {
      run: {
        ...run,
        identification: {
          ...run.identification,
          version: run.identification.version + 1,
          identification: after,
          evidenceHash: run.evidencePackage.evidenceHash,
          validationNotes: [
            ...run.identification.validationNotes,
            ...(droppedCount > 0
              ? [`Reconciliation dropped ${droppedCount} claim(s) no longer supported by the full crawl.`]
              : []),
          ],
        },
        status: "planning",
        auditEvents: [
          ...run.auditEvents,
          {
            timestamp: new Date().toISOString(),
            type: "application_model_reconciled",
            detail: { droppedClaimCount: droppedCount, evidenceHash: run.evidencePackage.evidenceHash },
            actor: "system",
          },
        ],
      },
    };
  };
}
