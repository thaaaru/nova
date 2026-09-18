import { describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { attemptStepRecovery } from "../src/services/recovery/recovery-agent.js";

async function withPage(html: string, run: (page: Page) => Promise<void>): Promise<void> {
  const browser: Browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await run(page);
  } finally {
    await browser.close();
  }
}

describe("attemptStepRecovery", () => {
  it("respects a zero budget and never tries an alternate locator", async () => {
    await withPage(`<button aria-label="Add to cart">Add to cart</button>`, async (page) => {
      const result = await attemptStepRecovery({
        page,
        step: { kind: "click", selector: "#missing", timeoutMs: 1000 },
        stepIndex: 0,
        failureSummary: "selector not found",
        budget: 0,
      });
      expect(result.recovered).toBe(false);
      expect(result.attempts).toHaveLength(0);
    });
  });

  it("recovers a click target by falling back to role+name when the declared selector is stale", async () => {
    await withPage(`<button>Add to cart</button>`, async (page) => {
      const result = await attemptStepRecovery({
        page,
        step: { kind: "click", role: "button", name: "Add to cart", selector: "#stale-id", timeoutMs: 1000 },
        stepIndex: 2,
        failureSummary: "#stale-id did not resolve",
        budget: 2,
      });
      expect(result.recovered).toBe(true);
      expect(result.attempts.at(-1)?.outcome).toBe("recovered");
      expect(result.attempts[0].maxAttempts).toBe(2);
    });
  });

  it("exhausts the budget and reports failure when no strategy uniquely resolves the element", async () => {
    await withPage(`<div>nothing matches</div>`, async (page) => {
      const result = await attemptStepRecovery({
        page,
        step: { kind: "click", role: "button", name: "Checkout", timeoutMs: 1000 },
        stepIndex: 5,
        failureSummary: "checkout button not found",
        budget: 2,
      });
      expect(result.recovered).toBe(false);
      expect(result.attempts.at(-1)?.outcome).toBe("exhausted");
      expect(result.attempts.length).toBeGreaterThan(0);
    });
  });

  it("never recovers an ambiguous match — multiple candidates stay unresolved", async () => {
    await withPage(`<button>Submit</button><button>Submit</button>`, async (page) => {
      const result = await attemptStepRecovery({
        page,
        step: { kind: "click", role: "button", name: "Submit", timeoutMs: 1000 },
        stepIndex: 0,
        failureSummary: "ambiguous",
        budget: 1,
      });
      expect(result.recovered).toBe(false);
    });
  });
});
