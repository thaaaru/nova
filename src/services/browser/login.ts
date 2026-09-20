import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { chromium } from "playwright";

export type CaptureStorageStateOptions = {
  url: string;
  outputPath: string;
  /**
   * Blocks until the operator has finished signing in by hand in the
   * headed browser window this opens — e.g. reading a line from stdin.
   * Nova never reads, stores, or reasons about the credential itself;
   * it only waits for the human to say "done," then captures whatever
   * session cookies/localStorage resulted.
   */
  waitForOperator: () => Promise<void>;
};

export type CaptureStorageStateResult = { outputPath: string };

/**
 * Opens a real, headed browser at `url`, lets the operator sign in by
 * hand, and once they confirm, serializes the resulting session to
 * `outputPath` so a later discover/run can reuse it via
 * `TargetManifest.storageStatePath`. No credential is ever read, stored,
 * or reasoned about by the harness — only a path to a cookie/localStorage
 * snapshot the operator produced themselves.
 */
export async function captureStorageState(
  options: CaptureStorageStateOptions,
): Promise<CaptureStorageStateResult> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: "load", timeout: 30_000 });

    await options.waitForOperator();

    mkdirSync(dirname(options.outputPath), { recursive: true });
    await context.storageState({ path: options.outputPath });
    chmodSync(options.outputPath, 0o600);

    return { outputPath: options.outputPath };
  } finally {
    await browser.close();
  }
}
