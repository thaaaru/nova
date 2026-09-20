import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Page, type Route } from "playwright";

import { runArtifactsDirectory, screenshotFileName } from "../artifacts.js";
import type { AppSnapshot, ExecutionResult, NavigationCheck, PageSnapshot, TargetPolicy } from "../domain.js";
import {
  PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES,
  getSafeDiscoveryUrl,
  normalizePolicy,
  type NormalizedPolicy,
} from "../policy.js";

export interface NavigationExecutionInput {
  runId: string;
  snapshot: AppSnapshot;
  policy: TargetPolicy;
  headless?: boolean;
  artifactsDirectory: string;
  storageStatePath?: string;
  onCheckStart?: (page: PageSnapshot) => void;
  onCheckComplete?: (check: NavigationCheck) => void;
}

export interface NavigationExecutor {
  execute(input: NavigationExecutionInput): Promise<ExecutionResult>;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A full-page screenshot resizes the viewport rather than genuinely
 * scrolling, so content gated behind an IntersectionObserver (fade-in
 * reveals, lazy-loaded images below the fold — extremely common on modern
 * marketing sites) never triggers and shows up blank. Scrolling through the
 * page in real increments fires those observers before the screenshot.
 */
async function scrollThroughPage(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        const step = 400;
        let scrolled = 0;
        let iterations = 0;
        const maxIterations = 100;
        const timer = window.setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, step);
          scrolled += step;
          iterations += 1;
          if (scrolled >= scrollHeight || iterations >= maxIterations) {
            window.clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 150);
      });
    })
    .catch(() => undefined);
}

/**
 * Executes only direct GET navigations and read-only title/heading assertions.
 * It deliberately exposes no click, fill, submit, upload, or credential capability.
 */
export class PlaywrightNavigationExecutor implements NavigationExecutor {
  async execute(input: NavigationExecutionInput): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const policy = normalizePolicy(input.snapshot.targetUrl, input.policy);
    const outputDirectory = join(runArtifactsDirectory(input.artifactsDirectory, input.runId), "execution");
    await mkdir(outputDirectory, { recursive: true });

    const browser = await chromium.launch({ headless: input.headless ?? true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: input.storageStatePath,
    });
    const checks: NavigationCheck[] = [];

    try {
      await context.route("**/*", async (route: Route) => {
        const request = route.request();
        const isCrossOrigin = !policy.allowedOrigins.includes(new URL(request.url()).origin);
        const isPassiveCrossOriginAsset =
          isCrossOrigin &&
          request.method() === "GET" &&
          PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES.has(request.resourceType());

        if (
          !isPassiveCrossOriginAsset &&
          (request.method() !== "GET" ||
            !getSafeDiscoveryUrl(request.url(), input.snapshot.targetUrl, policy))
        ) {
          await route.abort();
          return;
        }

        await route.continue();
      });

      const takenScreenshotNames = new Set<string>();
      for (const pageSnapshot of input.snapshot.pages) {
        input.onCheckStart?.(pageSnapshot);
        const screenshotName = screenshotFileName(pageSnapshot.path, takenScreenshotNames);
        takenScreenshotNames.add(screenshotName);
        const check = await this.checkPage(
          context.newPage(),
          pageSnapshot,
          input.snapshot.targetUrl,
          policy,
          join(outputDirectory, screenshotName),
        );
        input.onCheckComplete?.(check);
        checks.push(check);
      }
    } finally {
      await context.close();
      await browser.close();
    }

    const completedAt = new Date().toISOString();
    return {
      runId: input.runId,
      startedAt,
      completedAt,
      status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
      checks,
      interactions: [],
    };
  }

  private async checkPage(
    pagePromise: Promise<Page>,
    snapshot: PageSnapshot,
    targetUrl: string,
    policy: NormalizedPolicy,
    screenshotPath: string,
  ): Promise<NavigationCheck> {
    const page = await pagePromise;
    const expectedHeading = snapshot.headings.at(0);

    try {
      const safeSnapshotUrl = getSafeDiscoveryUrl(snapshot.url, targetUrl, policy);
      if (!safeSnapshotUrl) {
        throw new Error(`Snapshot route violates the execution policy: ${snapshot.url}`);
      }

      await page.goto(safeSnapshotUrl.href, { waitUntil: "load", timeout: 30_000 });
      if (!getSafeDiscoveryUrl(page.url(), targetUrl, policy)) {
        throw new Error(`Navigation redirected outside the execution policy: ${page.url()}`);
      }

      const observedTitle = normalizeText(await page.title());
      const observedHeading = normalizeText((await page.locator("h1").first().textContent()) ?? "");
      // "load" fires before web fonts swap in and before images/API-driven
      // content past the initial HTML finish loading. Wait for fonts, then
      // give the page a bounded window to go network-idle — capped and
      // non-fatal so a page with persistent connections (analytics,
      // websockets, polling) can't hang the screenshot indefinitely.
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await scrollThroughPage(page);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      const titleMatches = observedTitle === normalizeText(snapshot.title);
      const headingMatches =
        expectedHeading === undefined || observedHeading === normalizeText(expectedHeading);
      if (!titleMatches || !headingMatches) {
        return {
          url: snapshot.url,
          expectedTitle: snapshot.title,
          observedTitle,
          expectedHeading,
          observedHeading,
          status: "failed",
          screenshotPath,
          error: [
            !titleMatches ? "Page title differs from the approved discovery snapshot." : undefined,
            !headingMatches ? "Primary heading differs from the approved discovery snapshot." : undefined,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }

      return {
        url: snapshot.url,
        expectedTitle: snapshot.title,
        observedTitle,
        expectedHeading,
        observedHeading,
        status: "passed",
        screenshotPath,
      };
    } catch (error) {
      return {
        url: snapshot.url,
        expectedTitle: snapshot.title,
        expectedHeading,
        status: "failed",
        error: errorMessage(error),
      };
    } finally {
      await page.close();
    }
  }
}
