import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Locator, type Page, type Route } from "playwright";

import { runArtifactsDirectory, screenshotFileName } from "../artifacts.js";
import type { AppSnapshot, InteractionCheck, PlannedAction, TargetPolicy, TestPlan } from "../domain.js";
import {
  PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES,
  getSafeDiscoveryUrl,
  isPotentiallyDestructivePath,
  normalizePolicy,
  type NormalizedPolicy,
} from "../policy.js";

export interface InteractionExecutionInput {
  runId: string;
  snapshot: AppSnapshot;
  plan: TestPlan;
  policy: TargetPolicy;
  headless?: boolean;
  artifactsDirectory: string;
  storageStatePath?: string;
  onInteractionStart?: (description: string) => void;
  onInteractionComplete?: (result: InteractionCheck) => void;
}

export interface InteractionExecutor {
  execute(input: InteractionExecutionInput): Promise<InteractionCheck[]>;
}

type GroundedInteraction = {
  stepId: string;
  action: PlannedAction & { target: NonNullable<PlannedAction["target"]> };
};

function collectInteractions(plan: TestPlan): GroundedInteraction[] {
  const interactions: GroundedInteraction[] = [];
  for (const step of plan.steps) {
    for (const action of step.actions) {
      if (action.kind === "interact" && action.target) {
        interactions.push({ stepId: step.id, action: action as GroundedInteraction["action"] });
      }
    }
  }
  return interactions;
}

// Playwright's getByRole understands an element's *computed* ARIA role, so
// a plain <button> matches "button" without an explicit role attribute —
// this maps a discovered control's kind to the role getByRole expects,
// independent of whatever raw role attribute (if any) the discoverer saw.
function ariaRoleForKind(
  kind: string,
): "link" | "button" | "textbox" | "combobox" | "checkbox" | "radio" | undefined {
  switch (kind) {
    case "link":
      return "link";
    case "button":
      return "button";
    case "textbox":
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    default:
      return undefined;
  }
}

function locateControl(page: Page, target: NonNullable<PlannedAction["target"]>): Locator {
  const role = ariaRoleForKind(target.kind);
  const name = target.label ?? target.name;
  if (role && name) {
    return page.getByRole(role, { name, exact: false }).first();
  }
  if (name) {
    return page.getByText(name, { exact: false }).first();
  }
  throw new Error(`No locator strategy for a "${target.kind}" target without a label or name.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes only actions the safety filter already validated (grounded
 * target, non-destructive, interactions explicitly enabled for the run) —
 * this executor never re-derives that policy, it trusts the plan it's
 * given. Kept entirely separate from PlaywrightNavigationExecutor so the
 * read-only executor's "no click, fill, submit" guarantee stays intact and
 * unmodified regardless of this capability.
 */
export class PlaywrightInteractionExecutor implements InteractionExecutor {
  async execute(input: InteractionExecutionInput): Promise<InteractionCheck[]> {
    const interactions = collectInteractions(input.plan);
    if (interactions.length === 0) {
      return [];
    }

    const policy = normalizePolicy(input.snapshot.targetUrl, input.policy);
    const outputDirectory = join(
      runArtifactsDirectory(input.artifactsDirectory, input.runId),
      "interactions",
    );
    await mkdir(outputDirectory, { recursive: true });

    const browser = await chromium.launch({ headless: input.headless ?? true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: input.storageStatePath,
    });
    const results: InteractionCheck[] = [];

    try {
      await context.route("**/*", async (route: Route) => {
        const request = route.request();
        const isCrossOrigin = !policy.allowedOrigins.includes(new URL(request.url()).origin);

        if (request.method() === "GET") {
          const isPassiveCrossOriginAsset =
            isCrossOrigin && PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES.has(request.resourceType());
          if (
            !isPassiveCrossOriginAsset &&
            !getSafeDiscoveryUrl(request.url(), input.snapshot.targetUrl, policy)
          ) {
            await route.abort();
            return;
          }
          await route.continue();
          return;
        }

        // Non-GET (form submits, XHR/fetch writes) only ever proceeds
        // same-origin and never to a path that looks destructive by name —
        // the same denylist navigation already uses.
        if (isCrossOrigin || isPotentiallyDestructivePath(new URL(request.url()))) {
          await route.abort();
          return;
        }
        await route.continue();
      });

      const takenScreenshotNames = new Set<string>();
      for (const { stepId, action } of interactions) {
        input.onInteractionStart?.(action.description);
        const result = await this.runInteraction(
          context.newPage(),
          input.snapshot,
          stepId,
          action,
          policy,
          outputDirectory,
          takenScreenshotNames,
        );
        input.onInteractionComplete?.(result);
        results.push(result);
      }
    } finally {
      await context.close();
      await browser.close();
    }

    return results;
  }

  private async runInteraction(
    pagePromise: Promise<Page>,
    snapshot: AppSnapshot,
    stepId: string,
    action: GroundedInteraction["action"],
    policy: NormalizedPolicy,
    outputDirectory: string,
    takenScreenshotNames: Set<string>,
  ): Promise<InteractionCheck> {
    const page = await pagePromise;
    try {
      const targetPage = snapshot.pages.find((candidate) => candidate.path === action.target.page);
      if (!targetPage) {
        throw new Error(`Target page "${action.target.page}" is no longer part of the discovered app.`);
      }
      const safeUrl = getSafeDiscoveryUrl(targetPage.url, snapshot.targetUrl, policy);
      if (!safeUrl) {
        throw new Error(`Target page violates the execution policy: ${targetPage.url}`);
      }

      await page.goto(safeUrl.href, { waitUntil: "load", timeout: 30_000 });
      const locator = locateControl(page, action.target);

      switch (action.target.kind) {
        case "button":
        case "link":
          await locator.click({ timeout: 10_000 });
          break;
        case "textbox":
        case "textarea":
          await locator.fill(action.value ?? "", { timeout: 10_000 });
          break;
        case "checkbox":
        case "radio":
          await locator.check({ timeout: 10_000 });
          break;
        case "select":
          await locator.selectOption(action.value ?? "", { timeout: 10_000 });
          break;
        default:
          throw new Error(`Unsupported control kind for interaction: ${action.target.kind}`);
      }

      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

      const screenshotName = screenshotFileName(`${action.target.page}-${stepId}`, takenScreenshotNames);
      takenScreenshotNames.add(screenshotName);
      const screenshotPath = join(outputDirectory, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      return {
        stepId,
        description: action.description,
        status: "passed",
        observedUrl: page.url(),
        screenshotPath,
      };
    } catch (error) {
      return {
        stepId,
        description: action.description,
        status: "failed",
        error: errorMessage(error),
      };
    } finally {
      await page.close();
    }
  }
}
