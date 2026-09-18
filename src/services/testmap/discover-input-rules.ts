import type { ApplicationTestMapEnvironment } from "../../domain/index.js";

/**
 * Pure validation/derivation rules for the "discover a target" inputs
 * (target URL, application name, environment) — shared by the CLI's
 * guided-input resolver and the TUI's discovery/guided-setup screens, so
 * "what counts as a valid target URL" and "what environment does this
 * hostname suggest" are defined exactly once.
 */

const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(\s*https?:\/\/[^)]+\)/i;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates an http(s) URL, rejects Markdown link syntax, and strips a bare trailing slash. */
export function normalizeTargetUrl(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  if (MARKDOWN_LINK_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error:
        'Enter a plain URL, not Markdown link syntax (e.g. "https://teklab.dev", not "[text](https://teklab.dev)").',
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Enter a valid absolute URL, e.g. "https://teklab.dev".' };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "The target URL must use http or https." };
  }
  const normalized =
    url.pathname === "/" && url.search === "" && url.hash === ""
      ? url.toString().replace(/\/$/, "")
      : url.toString();
  return { ok: true, value: normalized };
}

/** `https://teklab.dev` -> `Teklab`; `https://www.acme-shop.example.com` -> `Acme-shop`. */
export function deriveApplicationName(targetUrl: string): string | undefined {
  try {
    const hostname = new URL(targetUrl).hostname.replace(/^www\./, "");
    const primaryLabel = hostname.split(".")[0];
    if (!primaryLabel) {
      return undefined;
    }
    return primaryLabel.charAt(0).toUpperCase() + primaryLabel.slice(1);
  } catch {
    return undefined;
  }
}

export const ENVIRONMENT_CHOICES: Array<{ label: string; value: ApplicationTestMapEnvironment }> = [
  { label: "Local", value: "local" },
  { label: "Development", value: "development" },
  { label: "Staging", value: "staging" },
  { label: "Production", value: "production" },
];

const LOCAL_HOSTNAME_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.local)$/i;
const DEVELOPMENT_HOSTNAME_PATTERN = /(^|\.)dev(elopment)?[.-]/i;

/** Defaults to "staging" unless the hostname clearly indicates a local or development target. */
export function deriveDefaultEnvironment(targetUrl: string): ApplicationTestMapEnvironment {
  try {
    const hostname = new URL(targetUrl).hostname;
    if (LOCAL_HOSTNAME_PATTERN.test(hostname)) {
      return "local";
    }
    if (DEVELOPMENT_HOSTNAME_PATTERN.test(hostname)) {
      return "development";
    }
  } catch {
    // Fall through to the staging default below.
  }
  return "staging";
}
