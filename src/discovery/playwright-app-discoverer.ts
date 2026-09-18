import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { runArtifactsDirectory, screenshotFileName } from "../artifacts.js";
import type { AppSnapshot, DiscoveredControl, PageSnapshot } from "../domain.js";
import {
  PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES,
  getSafeDiscoveryUrl,
  normalizePolicy,
  type NormalizedPolicy,
} from "../policy.js";
import type { AppDiscoverer, DiscoveryRequest } from "./contracts.js";

type RawControl = {
  tagName: string;
  role: string | null;
  label: string | null;
  name: string | null;
  inputType: string | null;
  disabled: boolean;
};

type RawLink = {
  href: string;
};

/**
 * Performs an inspect-only crawl. It never clicks, fills, submits, or follows
 * cross-origin requests. Crawled links are loaded with GET only and known
 * destructive paths are filtered by the policy layer.
 */
export class PlaywrightAppDiscoverer implements AppDiscoverer {
  async discover(request: DiscoveryRequest): Promise<AppSnapshot> {
    const policy = normalizePolicy(request.targetUrl, request.policy);
    const root = getSafeDiscoveryUrl(request.targetUrl, request.targetUrl, policy);
    if (!root) {
      throw new Error("The supplied target URL is not allowed by the discovery policy.");
    }

    const browser = await chromium.launch({ headless: request.headless ?? true });
    const context = await browser.newContext({
      serviceWorkers: "block",
      storageState: request.storageStatePath,
    });
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];

    await context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const isSafeProtocol = requestUrl.protocol === "data:" || requestUrl.protocol === "blob:";
      const isAllowedOrigin = policy.allowedOrigins.includes(requestUrl.origin);
      const isReadOnlyNavigation = !request.isNavigationRequest() || request.method() === "GET";
      const isPassiveCrossOriginAsset =
        !isAllowedOrigin &&
        request.method() === "GET" &&
        PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES.has(request.resourceType());

      if ((!isSafeProtocol && !isAllowedOrigin && !isPassiveCrossOriginAsset) || !isReadOnlyNavigation) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleMessages.push(redactAndTruncate(message.text()));
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redactAndTruncate(error.message)));

    const discoveryDirectory = join(
      runArtifactsDirectory(request.artifactsDirectory, request.runId),
      "discovery",
    );
    await mkdir(discoveryDirectory, { recursive: true });
    const takenScreenshotNames = new Set<string>();
    const pages: PageSnapshot[] = [];
    const warnings: string[] = [];
    const queued = [root.toString()];
    const visited = new Set<string>();

    try {
      while (queued.length > 0 && pages.length < policy.maxPages) {
        const candidate = queued.shift();
        if (!candidate || visited.has(candidate)) {
          continue;
        }
        visited.add(candidate);

        const consoleStart = consoleMessages.length;
        const pageErrorStart = pageErrors.length;

        try {
          await page.goto(candidate, { waitUntil: "load", timeout: 20_000 });
          const snapshot = await this.capturePage(
            page,
            candidate,
            policy,
            consoleMessages.slice(consoleStart),
            pageErrors.slice(pageErrorStart),
          );
          const screenshotPath = await this.captureScreenshot(
            page,
            discoveryDirectory,
            snapshot.path,
            takenScreenshotNames,
          );
          if (!screenshotPath) {
            warnings.push(`Could not capture a screenshot for ${candidate}`);
          }
          pages.push(screenshotPath ? { ...snapshot, screenshotPath } : snapshot);

          for (const link of snapshot.links) {
            if (
              !visited.has(link) &&
              !queued.includes(link) &&
              queued.length + pages.length < policy.maxPages
            ) {
              queued.push(link);
            }
          }
        } catch (error) {
          warnings.push(`Could not inspect ${candidate}: ${redactAndTruncate(toErrorMessage(error))}`);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }

    if (pages.length === 0) {
      throw new Error("Discovery did not capture any pages. Review the target URL and network policy.");
    }

    if (queued.length > 0) {
      warnings.push(`Discovery stopped after the configured limit of ${policy.maxPages} page(s).`);
    }

    return {
      id: randomUUID(),
      targetUrl: root.toString(),
      discoveredAt: new Date().toISOString(),
      pages,
      warnings: unique(warnings),
    };
  }

  private async capturePage(
    page: Page,
    requestedUrl: string,
    policy: NormalizedPolicy,
    consoleErrors: string[],
    pageErrors: string[],
  ): Promise<PageSnapshot> {
    const currentUrl = getSafeDiscoveryUrl(page.url(), requestedUrl, policy);
    if (!currentUrl) {
      throw new Error("The page redirected outside the approved discovery scope.");
    }

    const [title, headings, rawControls, rawLinks] = await Promise.all([
      page.title(),
      page
        .locator("h1, h2, h3, [role='heading']")
        .evaluateAll((elements) => elements.slice(0, 30).map((element) => element.textContent ?? "")),
      page.locator("button, input, textarea, select, form, [role]").evaluateAll((elements) =>
        elements.slice(0, 200).map((element) => {
          const htmlElement = element as HTMLElement;
          const input = element as HTMLInputElement;
          return {
            tagName: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            label:
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              input.labels?.[0]?.textContent ??
              element.closest("label")?.textContent ??
              htmlElement.innerText ??
              null,
            name: element.getAttribute("name"),
            inputType: input.type || null,
            disabled: "disabled" in htmlElement && Boolean((htmlElement as HTMLButtonElement).disabled),
          };
        }),
      ),
      page
        .locator("a[href]")
        .evaluateAll((elements) =>
          elements.slice(0, 200).map((element) => ({ href: (element as HTMLAnchorElement).href })),
        ),
    ]);

    const links = rawLinks
      .map((link: RawLink) => getSafeDiscoveryUrl(link.href, currentUrl.toString(), policy)?.toString())
      .filter((link): link is string => Boolean(link))
      .slice(0, policy.maxLinksPerPage);
    const controls = rawControls
      .map((control: RawControl) => normalizeControl(control))
      .slice(0, policy.maxControlsPerPage);
    const sanitizedHeadings = headings.map(redactAndTruncate).filter(Boolean).slice(0, 30);
    const safeTitle = redactAndTruncate(title);

    const snapshotWithoutFingerprint = {
      url: currentUrl.toString(),
      path: `${currentUrl.pathname}${currentUrl.search}`,
      title: safeTitle,
      headings: unique(sanitizedHeadings),
      controls,
      links: unique(links),
      consoleErrors: unique(consoleErrors),
      pageErrors: unique(pageErrors),
    };

    return {
      ...snapshotWithoutFingerprint,
      fingerprint: fingerprint(JSON.stringify(snapshotWithoutFingerprint)),
    };
  }

  private async captureScreenshot(
    page: Page,
    directory: string,
    path: string,
    taken: Set<string>,
  ): Promise<string | undefined> {
    const name = screenshotFileName(path, taken);
    const filePath = join(directory, name);
    try {
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      await page.screenshot({ path: filePath, fullPage: true });
    } catch {
      return undefined;
    }
    taken.add(name);
    return filePath;
  }
}

function normalizeControl(raw: RawControl): DiscoveredControl {
  const text = `${raw.role ?? ""} ${raw.inputType ?? ""}`.toLowerCase();
  let kind: DiscoveredControl["kind"] = "other";

  if (raw.tagName === "a") kind = "link";
  else if (raw.tagName === "button" || raw.role === "button") kind = "button";
  else if (raw.tagName === "textarea") kind = "textarea";
  else if (raw.tagName === "select" || raw.role === "combobox") kind = "select";
  else if (text.includes("checkbox")) kind = "checkbox";
  else if (text.includes("radio")) kind = "radio";
  else if (raw.tagName === "input" || raw.role === "textbox") kind = "textbox";
  else if (raw.tagName === "form" || raw.role === "form") kind = "form";
  else if (raw.role === "dialog") kind = "dialog";
  else if (raw.role === "heading") kind = "heading";

  return {
    kind,
    role: raw.role ?? undefined,
    label: raw.label ? redactAndTruncate(raw.label) : undefined,
    name: raw.name ? redactAndTruncate(raw.name) : undefined,
    inputType: raw.inputType ?? undefined,
    disabled: raw.disabled,
  };
}

function redactAndTruncate(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:bearer|token|api[_-]?key|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
