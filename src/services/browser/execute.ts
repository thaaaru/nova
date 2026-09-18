import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page, type Route } from "playwright";

import type {
  Assertion,
  ExecutionResult,
  StepResult,
  TargetManifest,
  TestCase,
  TestStep,
} from "../../domain/index.js";
import { isDomainAllowed } from "../policy/scope-policy.js";
import { resolveIfSecretReference, type SecretResolver } from "../policy/secret-resolver.js";

export type ExecuteCaseOptions = {
  runId: string;
  manifest: TargetManifest;
  testCase: TestCase;
  artifactsDirectory: string;
  headless?: boolean;
  secretResolver: SecretResolver;
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
  const startedAt = new Date().toISOString();
  const maxAttempts = options.testCase.retryPolicy.maxAttempts;
  let lastResult: ExecutionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await runOnce(options, attempt, startedAt);
    if (lastResult.assertionResults.every((assertion) => assertion.passed) && !lastResult.error) {
      return lastResult;
    }
    if (attempt < maxAttempts && options.testCase.retryPolicy.backoffMs > 0) {
      await delay(options.testCase.retryPolicy.backoffMs);
    }
  }
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
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });

  const consoleLogs: string[] = [];
  const screenshots: string[] = [];
  const stepResults: StepResult[] = [];
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

    for (const [index, step] of options.testCase.steps.entries()) {
      const stepStart = Date.now();
      try {
        await runStep(page, step, options.secretResolver);
        stepResults.push({ stepIndex: index, status: "passed", durationMs: Date.now() - stepStart });
      } catch (error) {
        stepResults.push({
          stepIndex: index,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - stepStart,
        });
        const screenshotPath = join(outputDirectory, `failure-step-${index}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        screenshots.push(screenshotPath);
        break;
      }
    }

    const assertionResults = await Promise.all(
      options.testCase.assertions.map((assertion) => evaluateAssertion(page, assertion)),
    );

    const tracePath = join(outputDirectory, `trace-attempt-${attempt}.zip`);
    await context.tracing.stop({ path: tracePath });

    return {
      caseId: options.testCase.id,
      attempts: attempt,
      stepResults,
      assertionResults,
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

async function runStep(page: Page, step: TestStep, secretResolver: SecretResolver): Promise<void> {
  switch (step.kind) {
    case "navigate":
      if (!step.url) {
        throw new Error("navigate step requires url.");
      }
      await page.goto(step.url, { waitUntil: "load", timeout: step.timeoutMs });
      return;
    case "click":
      await locate(page, step).click({ timeout: step.timeoutMs });
      return;
    case "fill": {
      const value = step.value ? resolveIfSecretReference(step.value, secretResolver) : "";
      await locate(page, step).fill(value, { timeout: step.timeoutMs });
      return;
    }
    case "select":
      await locate(page, step).selectOption(step.value ?? "", { timeout: step.timeoutMs });
      return;
    case "check":
      await locate(page, step).check({ timeout: step.timeoutMs });
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
