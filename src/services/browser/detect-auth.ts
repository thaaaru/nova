import { chromium } from "playwright";

export type DetectAuthOptions = {
  url: string;
  headless?: boolean;
};

export type DetectAuthResult = {
  required: boolean;
  reason?: string;
};

const AUTH_PATH_PATTERN = /\/(login|signin|sign-in|auth|sso)(\/|$)/i;

/**
 * A lightweight, read-only probe: opens a single page at `url` and
 * classifies whether the target appears to sit behind an authentication
 * wall — via an HTTP 401/403, a redirect to a login-shaped path, or a
 * sparse landing page that's really just a sign-in form. Used to steer
 * the guided flow (e.g. suggest capturing storage state) before a real
 * crawl is attempted; it never performs any write action itself.
 */
export async function detectAuthRequirement(
  options: DetectAuthOptions,
): Promise<DetectAuthResult> {
  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const page = await browser.newPage();

    let response;
    try {
      response = await page.goto(options.url, { waitUntil: "load", timeout: 15_000 });
    } catch {
      // Navigation failed entirely (DNS, timeout, refused connection, etc.).
      // Deliberately don't treat this as an auth signal: the probe's job is
      // only to detect auth walls, never to block the guided flow on its
      // own failure — the real crawl's own error handling will surface the
      // actual problem to the operator.
      return { required: false };
    }

    const status = response?.status();
    if (status === 401 || status === 403) {
      return { required: true, reason: `Received ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}` };
    }

    const requestedPath = new URL(options.url).pathname;
    const finalUrl = page.url();
    const finalPath = new URL(finalUrl).pathname;
    if (AUTH_PATH_PATTERN.test(finalPath) && !AUTH_PATH_PATTERN.test(requestedPath)) {
      return { required: true, reason: `Redirected to ${finalUrl}` };
    }

    const passwordFieldCount = await page.locator('input[type="password"]').count();
    if (passwordFieldCount > 0) {
      const linkCount = await page.locator("a[href]").count();
      const buttonCount = await page.locator("button").count();
      if (linkCount + buttonCount <= 12) {
        return { required: true, reason: "Landing page presents a sign-in form" };
      }
    }

    return { required: false };
  } finally {
    await browser.close();
  }
}
