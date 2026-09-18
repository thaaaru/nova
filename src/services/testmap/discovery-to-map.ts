import { randomUUID } from "node:crypto";

import type {
  ApplicationArea,
  ApplicationTestMap,
  ApplicationTestMapEnvironment,
  DiscoveredPage,
  DiscoverySnapshot,
  KnownConstraint,
  RiskLevel,
  UserJourney,
} from "../../domain/index.js";

export type DiscoveryToMapOptions = {
  applicationName: string;
  environment: ApplicationTestMapEnvironment;
  allowedDomains: string[];
};

/**
 * Deterministically groups a page's URL into a candidate functional area
 * name from its first path segment — "checkout", "cart", "account", etc.
 * Never a model's guess: pure string parsing of a URL Nova already
 * crawled inside the manifest's approved scope.
 */
function areaNameFromPage(page: DiscoveredPage): string {
  const segment = new URL(page.url).pathname.split("/").filter(Boolean)[0];
  if (!segment) {
    return "Home";
  }
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One read-only "smoke check" candidate journey per visited page — mirrors
 * the deterministic read-only case plan-templates.ts already generates
 * for the plain discover/plan path, just reshaped into the map's
 * UserJourney/Checkpoint schema and left in "draft" status until a QA
 * engineer reviews and approves it.
 */
function smokeJourneyForPage(page: DiscoveredPage, areaId: string): UserJourney {
  return {
    id: `journey-${slug(page.title || page.url)}-smoke-${slug(areaId)}`.slice(0, 80),
    areaId,
    name: `${page.title || page.url} loads`,
    description: `Visit ${page.url} and confirm it loads with no console errors.`,
    mode: "quick_test",
    requiredPersonaIds: [],
    requiredFixtureIds: [],
    checkpoints: [
      {
        id: "checkpoint-page-loads",
        name: "Page loads",
        expectedOutcome: `${page.url} responds and renders "${page.title}".`,
        riskLevel: "low",
        requiresApproval: false,
        evidenceRequirements: ["screenshot"],
        steps: [{ kind: "navigate", url: page.url, timeoutMs: 10_000 }],
        assertions: [{ kind: "titleContains", expected: page.title || "" }],
      },
    ],
    allowedRecoveryActions: [],
    status: "draft",
  };
}

/**
 * One candidate state-changing journey per discovered form — draft,
 * guided_test (a human must supply the concrete field values/persona
 * before it can run), consistent with plan-templates.ts's existing
 * "one state-changing case per discovered form" heuristic.
 */
function formJourneyForPage(page: DiscoveredPage, areaId: string, formIndex: number): UserJourney {
  const form = page.forms[formIndex];
  return {
    id: `journey-${slug(page.title || page.url)}-form-${formIndex}-${slug(areaId)}`.slice(0, 80),
    areaId,
    name: `Submit form on ${page.title || page.url}`,
    description: `Complete and submit the form at ${form.selector} on ${page.url}.`,
    mode: "guided_test",
    requiredPersonaIds: [],
    requiredFixtureIds: [],
    checkpoints: [
      {
        id: "checkpoint-form-submission",
        name: "Form submits",
        expectedOutcome: "The form submits without a client- or server-side error.",
        riskLevel: "medium",
        requiresApproval: true,
        evidenceRequirements: ["screenshot", "trace"],
        steps: [{ kind: "navigate", url: page.url, timeoutMs: 10_000 }],
        assertions: [{ kind: "urlContains", expected: "" }],
      },
    ],
    allowedRecoveryActions: ["role_name_match", "visible_text_match"],
    status: "draft",
  };
}

/**
 * Builds an initial draft Application Test Map straight from a
 * DiscoverySnapshot — deterministic grouping/heuristics only, never a
 * model. The result's `status` is always "draft": nothing here is
 * runnable until a QA engineer reviews it via `nova map show`/the TUI's
 * "Explore and update application map" screen and explicitly accepts or
 * edits it (journeys individually move draft -> approved via
 * `nova journey approve`).
 */
export function buildDraftMapFromDiscovery(
  discovery: DiscoverySnapshot,
  options: DiscoveryToMapOptions,
): ApplicationTestMap {
  const areasByName = new Map<string, ApplicationArea>();
  const knownConstraints: KnownConstraint[] = [];

  for (const page of discovery.pages) {
    const areaName = areaNameFromPage(page);
    const areaId = slug(areaName) || "home";
    let area = areasByName.get(areaId);
    if (!area) {
      area = { id: areaId, name: areaName, riskLevel: "low" as RiskLevel, journeys: [] };
      areasByName.set(areaId, area);
    }

    area.journeys.push(smokeJourneyForPage(page, areaId));
    page.forms.forEach((_form, formIndex) => {
      area.journeys.push(formJourneyForPage(page, areaId, formIndex));
      area.riskLevel = "medium";
    });

    if (page.consoleErrors.length > 0) {
      knownConstraints.push({
        id: `constraint-console-errors-${slug(page.url)}`.slice(0, 80),
        description: `${page.consoleErrors.length} browser console error(s) observed on ${page.url}.`,
        areaId,
        severity: "warning",
      });
    }
  }

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    version: "0.1.0-draft",
    applicationName: options.applicationName,
    targetUrl: discovery.targetUrl,
    environment: options.environment,
    approvedScope: {
      allowedDomains: options.allowedDomains,
      allowedApiHosts: discovery.apiEndpoints,
      allowedMethods: ["GET", "POST"],
      executionMode: "observe",
    },
    areas: [...areasByName.values()],
    personas: [],
    fixtures: [],
    knownConstraints,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}
