import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page, type Route } from "playwright";

import type {
  Assertion,
  ExecutionResult,
  RecoveryAttempt,
  StepResult,
  TargetManifest,
  TestCase,
  TestStep,
} from "../../domain/index.js";
import { isDomainAllowed } from "../policy/scope-policy.js";
import { resolveIfSecretReference, type SecretResolver } from "../policy/secret-resolver.js";
import { attemptStepRecovery } from "../recovery/recovery-agent.js";

export type ExecuteCaseOptions = {
  runId: string;
  manifest: TargetManifest;
  testCase: TestCase;
  artifactsDirectory: string;
  headless?: boolean;
  secretResolver: SecretResolver;
  /** Fired at each meaningful execution step so an operator watching `nova run`/`nova journey run` sees live progress instead of a silent wait; never required, never throws on the caller's behalf. */
  onProgress?: (message: string) => void;
};

/**
 * Runs one atomic TestCase's declared steps and assertions, deterministically
 * — there is no model in this path at all. Every navigation is checked
 * against the manifest's domain allow-list before it's allowed to proceed;
 * an out-of-scope navigation aborts the case immediately rather than
 * silently following it. Retries only happen per the case's own declared
 * retryPolicy, never an ad hoc "try again" decision.
 */
export async function executeTestCase(options: ExecuteCaseOptions): Promise<ExecutionResult> {
  const log = options.onProgress ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const maxAttempts = options.testCase.retryPolicy.maxAttempts;
  let lastResult: ExecutionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(
      maxAttempts > 1
        ? `Running "${options.testCase.title}" (attempt ${attempt}/${maxAttempts})`
        : `Running "${options.testCase.title}"`,
    );
    lastResult = await runOnce(options, attempt, startedAt);
    if (lastResult.assertionResults.every((assertion) => assertion.passed) && !lastResult.error) {
      log(`"${options.testCase.title}" passed`);
      return lastResult;
    }
    if (attempt < maxAttempts && options.testCase.retryPolicy.backoffMs > 0) {
      await delay(options.testCase.retryPolicy.backoffMs);
    }
  }
  log(`"${options.testCase.title}" failed`);
  return lastResult as ExecutionResult;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function runOnce(
  options: ExecuteCaseOptions,
  attempt: number,
  startedAt: string,
): Promise<ExecutionResult> {
  const outputDirectory = join(options.artifactsDirectory, options.runId, options.testCase.id);
  mkdirSync(outputDirectory, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext(
    options.manifest.storageStatePath ? { storageState: options.manifest.storageStatePath } : {},
  );
  await context.tracing.start({ screenshots: true, snapshots: true });

  const consoleLogs: string[] = [];
  const screenshots: string[] = [];
  const stepResults: StepResult[] = [];
  const recoveryAttempts: RecoveryAttempt[] = [];
  let blockedDomain: string | undefined;

  try {
    const page = await context.newPage();
    page.on("console", (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));

    await context.route("**/*", async (route: Route) => {
      const url = route.request().url();
      if (!isDomainAllowed(url, options.manifest)) {
        blockedDomain = new URL(url).hostname;
        await route.abort();
        return;
      }
      await route.continue();
    });

    const log = options.onProgress ?? (() => undefined);
    const totalSteps = options.testCase.steps.length;
    for (const [index, step] of options.testCase.steps.entries()) {
      const stepStart = Date.now();
      log(`Step ${index + 1}/${totalSteps}: ${step.kind}`);
      try {
        await runStep(page, step, options.secretResolver);
        stepResults.push({ stepIndex: index, status: "passed", durationMs: Date.now() - stepStart });
      } catch (error) {
        const failureSummary = error instanceof Error ? error.message : String(error);
        log(`Step ${index + 1} failed: ${failureSummary}`);
        const recovery = RECOVERABLE_STEP_KINDS.has(step.kind)
          ? await (async () => {
              log(`Attempting selector recovery for step ${index + 1}...`);
              const outcome = await attemptStepRecovery({
                page,
                step,
                stepIndex: index,
                failureSummary,
                budget: options.testCase.recoveryBudget,
              });
              log(
                outcome.recovered
                  ? `Recovery succeeded for step ${index + 1}`
                  : `Recovery exhausted for step ${index + 1} (${outcome.attempts.length} attempt(s))`,
              );
              return outcome;
            })()
          : { recovered: false, attempts: [] as RecoveryAttempt[] };
        recoveryAttempts.push(...recovery.attempts);

        if (recovery.recovered && recovery.usedLocator) {
          try {
            await runStep(page, step, options.secretResolver, recovery.usedLocator);
            stepResults.push({ stepIndex: index, status: "passed", durationMs: Date.now() - stepStart });
            continue;
          } catch (retryError) {
            const retrySummary = retryError instanceof Error ? retryError.message : String(retryError);
            stepResults.push({
              stepIndex: index,
              status: "failed",
              error: `${failureSummary}; recovery locator also failed: ${retrySummary}`,
              durationMs: Date.now() - stepStart,
            });
            const screenshotPath = join(outputDirectory, `failure-step-${index}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
            screenshots.push(screenshotPath);
            break;
          }
        }

        stepResults.push({
          stepIndex: index,
          status: "failed",
          error: failureSummary,
          durationMs: Date.now() - stepStart,
        });
        const screenshotPath = join(outputDirectory, `failure-step-${index}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        screenshots.push(screenshotPath);
        break;
      }
    }

    log(`Checking ${options.testCase.assertions.length} assertion(s)...`);
    const assertionResults = await Promise.all(
      options.testCase.assertions.map((assertion) => evaluateAssertion(page, assertion)),
    );
    for (const assertion of assertionResults) {
      log(
        `Assertion ${assertion.kind}: ${assertion.passed ? "passed" : `failed (expected ${assertion.expected}, observed ${assertion.observed ?? "n/a"})`}`,
      );
    }

    const tracePath = join(outputDirectory, `trace-attempt-${attempt}.zip`);
    await context.tracing.stop({ path: tracePath });

    return {
      caseId: options.testCase.id,
      attempts: attempt,
      stepResults,
      assertionResults,
      recoveryAttempts,
      screenshots,
      consoleLogs,
      tracePath,
      startedAt,
      completedAt: new Date().toISOString(),
      error: blockedDomain
        ? `Navigation blocked: ${blockedDomain} is outside the approved scope manifest.`
        : undefined,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runStep(
  page: Page,
  step: TestStep,
  secretResolver: SecretResolver,
  locatorOverride?: ReturnType<Page["locator"]>,
): Promise<void> {
  switch (step.kind) {
    case "navigate":
      if (!step.url) {
        throw new Error("navigate step requires url.");
      }
      await page.goto(step.url, { waitUntil: "load", timeout: step.timeoutMs });
      return;
    case "click":
      await (locatorOverride ?? locate(page, step)).click({ timeout: step.timeoutMs });
      return;
    case "fill": {
      const value = step.value ? resolveIfSecretReference(step.value, secretResolver) : "";
      await (locatorOverride ?? locate(page, step)).fill(value, { timeout: step.timeoutMs });
      return;
    }
    case "select":
      await (locatorOverride ?? locate(page, step)).selectOption(step.value ?? "", {
        timeout: step.timeoutMs,
      });
      return;
    case "check":
      await (locatorOverride ?? locate(page, step)).check({ timeout: step.timeoutMs });
      return;
    case "waitForSelector":
      if (!step.selector) {
        throw new Error("waitForSelector step requires selector.");
      }
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs });
      return;
    case "waitForUrl":
      if (!step.url) {
        throw new Error("waitForUrl step requires url.");
      }
      await page.waitForURL(step.url, { timeout: step.timeoutMs });
      return;
    default:
      throw new Error(`Unsupported step kind: ${(step as TestStep).kind}`);
  }
}

/** Step kinds recovery may retry with an alternate locator; navigation/wait steps never qualify. */
const RECOVERABLE_STEP_KINDS = new Set<TestStep["kind"]>(["click", "fill", "select", "check"]);

function locate(page: Page, step: TestStep) {
  if (step.selector) {
    return page.locator(step.selector).first();
  }
  if (step.role && step.name) {
    return page.getByRole(step.role as Parameters<Page["getByRole"]>[0], { name: step.name }).first();
  }
  if (step.name) {
    return page.getByText(step.name, { exact: false }).first();
  }
  throw new Error(`Step "${step.kind}" needs a selector, or a role+name, to locate an element.`);
}

async function evaluateAssertion(
  page: Page,
  assertion: Assertion,
): Promise<{ kind: string; expected: string; passed: boolean; observed?: string }> {
  switch (assertion.kind) {
    case "urlEquals":
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        passed: page.url() === assertion.expected,
        observed: page.url(),
      };
    case "urlContains":
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        passed: page.url().includes(assertion.expected),
        observed: page.url(),
      };
    case "titleContains": {
      const title = await page.title();
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        passed: title.includes(assertion.expected),
        observed: title,
      };
    }
    case "textVisible": {
      const visible = await page
        .getByText(assertion.expected, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      return { kind: assertion.kind, expected: assertion.expected, passed: visible };
    }
    case "elementVisible": {
      if (!assertion.target) {
        return {
          kind: assertion.kind,
          expected: assertion.expected,
          passed: false,
          observed: "no target selector supplied",
        };
      }
      const visible = await page
        .locator(assertion.target)
        .first()
        .isVisible()
        .catch(() => false);
      return { kind: assertion.kind, expected: assertion.expected, passed: visible };
    }
    case "statusCode":
      // Best-effort within a deterministic MVP: without a captured navigation
      // response, this assertion kind is inconclusive rather than falsely
      // passed or failed.
      return {
        kind: assertion.kind,
        expected: assertion.expected,
        passed: false,
        observed: "unsupported without a captured response",
      };
    default:
      return { kind: assertion.kind, expected: assertion.expected, passed: false };
  }
}
