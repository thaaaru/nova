import { launch as launchChrome } from "chrome-launcher";
import lighthouse, { type Result as LHResult } from "lighthouse";
import { chromium } from "playwright";

import type { LighthouseAuditResult } from "../domain.js";

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo", "agentic-browsing"];

// Score display modes that aren't a real pass/fail finding — nothing to
// report on for these even when `score` is low or null.
const NON_FINDING_DISPLAY_MODES = new Set(["manual", "informative", "notApplicable", "error"]);

/**
 * Runs a Lighthouse audit against `url` using a dedicated Chrome instance
 * (Playwright's own bundled Chromium — no separate browser install needed),
 * entirely separate from the browser Nova uses for navigation checks.
 * Never throws: a Lighthouse failure must not fail the overall run.
 */
export async function runLighthouseAudit(url: string): Promise<LighthouseAuditResult | undefined> {
  let chrome;
  try {
    chrome = await launchChrome({
      chromePath: chromium.executablePath(),
      chromeFlags: ["--headless=new", "--no-sandbox"],
    });
  } catch {
    return undefined;
  }

  try {
    const runnerResult = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: CATEGORIES,
      output: "json",
    });
    // Lighthouse doesn't throw for a page it couldn't load — it returns a
    // "successful" run with runtimeError set and every category score null.
    // Treat that the same as any other audit failure: absent, not a report
    // full of meaningless dashes.
    if (!runnerResult || runnerResult.lhr.runtimeError) {
      return undefined;
    }
    return extractResult(url, runnerResult.lhr);
  } catch {
    return undefined;
  } finally {
    chrome.kill();
  }
}

function extractResult(url: string, lhr: LHResult): LighthouseAuditResult {
  const categories = Object.values(lhr.categories).map((category) => ({
    id: category.id,
    title: category.title,
    score: category.score,
  }));

  const findings: LighthouseAuditResult["findings"] = [];
  for (const category of Object.values(lhr.categories)) {
    for (const ref of category.auditRefs) {
      if (ref.weight === 0) {
        continue;
      }
      const audit = lhr.audits[ref.id];
      if (!audit || NON_FINDING_DISPLAY_MODES.has(audit.scoreDisplayMode)) {
        continue;
      }
      if (audit.score !== null && audit.score >= 0.9) {
        continue;
      }
      findings.push({
        category: category.title,
        title: audit.title,
        description: audit.description,
        score: audit.score,
      });
    }
  }

  return { url, categories, findings };
}
