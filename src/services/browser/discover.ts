import { randomUUID } from "node:crypto";

import { chromium } from "playwright";

import type {
  DiscoveredForm,
  DiscoveredPage,
  DiscoverySnapshot,
  TargetManifest,
} from "../../domain/index.js";
import { isDomainAllowed } from "../policy/scope-policy.js";

export type DiscoverOptions = {
  runId: string;
  manifest: TargetManifest;
  maxPages?: number;
  headless?: boolean;
};

/**
 * A shallow, read-only crawl: visits the base URL and same-scope links
 * found on it (breadth-first, one hop), captures titles/forms/buttons/
 * links/console errors/network endpoints. No clicks, no fills, no form
 * submits — discovery never touches application state, matching the
 * read-only-by-default posture the whole product commits to.
 */
export async function discoverApplication(options: DiscoverOptions): Promise<DiscoverySnapshot> {
  const maxPages = options.maxPages ?? 5;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const visitedUrls: string[] = [];
  const pages: DiscoveredPage[] = [];
  const apiEndpoints = new Set<string>();

  try {
    const context = await browser.newContext();
    const queue: string[] = [options.manifest.baseUrl];
    const seen = new Set<string>();

    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift();
      if (!url || seen.has(url) || !isDomainAllowed(url, options.manifest)) {
        continue;
      }
      seen.add(url);

      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("request", (request) => {
        if (request.resourceType() === "xhr" || request.resourceType() === "fetch") {
          apiEndpoints.add(request.url());
        }
      });

      try {
        await page.goto(url, { waitUntil: "load", timeout: 15_000 });
      } catch {
        await page.close();
        continue;
      }

      visitedUrls.push(page.url());
      const title = await page.title();

      const forms = await page.$$eval("form", (elements) =>
        elements.map((form, index) => ({
          selector: form.id ? `#${form.id}` : `form:nth-of-type(${index + 1})`,
          action: form.getAttribute("action") ?? undefined,
          method: form.getAttribute("method") ?? undefined,
          fields: Array.from(form.elements).map((element) => ({
            name: element.getAttribute("name") ?? undefined,
            type: element.getAttribute("type") ?? element.tagName.toLowerCase(),
          })),
        })),
      );

      const buttons = await page.$$eval("button, [role=button]", (elements) =>
        elements.slice(0, 50).map((element) => ({
          kind: "button" as const,
          text: element.textContent?.trim().slice(0, 200) ?? "",
        })),
      );

      const links = await page.$$eval("a[href]", (elements) =>
        elements.slice(0, 100).map((element) => ({
          kind: "link" as const,
          text: element.textContent?.trim().slice(0, 200) ?? "",
          href: element.getAttribute("href") ?? undefined,
        })),
      );

      pages.push({
        url: page.url(),
        title,
        forms: forms as DiscoveredForm[],
        buttons,
        links,
        consoleErrors,
      });

      for (const link of links) {
        if (!link.href) {
          continue;
        }
        try {
          const resolved = new URL(link.href, page.url()).toString();
          if (isDomainAllowed(resolved, options.manifest) && !seen.has(resolved)) {
            queue.push(resolved);
          }
        } catch {
          // Ignore unparseable hrefs (mailto:, javascript:, etc.).
        }
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  return {
    runId: options.runId,
    targetUrl: options.manifest.baseUrl,
    visitedUrls,
    pages,
    apiEndpoints: Array.from(apiEndpoints),
    capturedAt: new Date().toISOString(),
  };
}

export function newRunId(): string {
  return randomUUID();
}
