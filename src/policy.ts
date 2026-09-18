import type { TargetPolicy } from "./domain.js";

export const DANGEROUS_PATH_PARTS = [
  "delete",
  "destroy",
  "logout",
  "signout",
  "unsubscribe",
  "remove",
  "revoke",
  "terminate",
];

// Passive rendering assets (fonts, stylesheets, images, scripts, media) are
// allowed cross-origin so pages depending on them (Google Fonts, CDN icon
// libraries, etc.) render accurately in discovery/execution screenshots.
// Navigation, XHR/fetch, and websockets stay origin-restricted — the crawler
// must not wander off-site or trigger third-party API calls.
export const PASSIVE_CROSS_ORIGIN_RESOURCE_TYPES = new Set([
  "stylesheet",
  "font",
  "image",
  "media",
  "script",
]);

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export type NormalizedPolicy = TargetPolicy & {
  allowedOrigins: string[];
};

export function normalizePolicy(targetUrl: string, policy: TargetPolicy): NormalizedPolicy {
  const target = parseAbsoluteUrl(targetUrl);
  assertSupportedProtocol(target, policy.allowInsecureHttp);
  assertNoEmbeddedCredentials(target);

  const allowedOrigins = [...new Set([target.origin, ...policy.allowedOrigins.map(normalizeOrigin)])];
  return { ...policy, allowedOrigins };
}

export function getSafeDiscoveryUrl(
  candidate: string,
  baseUrl: string,
  policy: NormalizedPolicy,
): URL | undefined {
  let url: URL;

  try {
    url = new URL(candidate, baseUrl);
  } catch {
    return undefined;
  }

  if (!isSupportedProtocol(url, policy.allowInsecureHttp) || !policy.allowedOrigins.includes(url.origin)) {
    return undefined;
  }

  if (url.username || url.password || isPotentiallyDestructivePath(url)) {
    return undefined;
  }

  url.hash = "";
  return url;
}

export function assertSafeTarget(targetUrl: string, policy: TargetPolicy): NormalizedPolicy {
  return normalizePolicy(targetUrl, policy);
}

function normalizeOrigin(value: string): string {
  const url = parseAbsoluteUrl(value);
  assertNoEmbeddedCredentials(url);
  return url.origin;
}

function parseAbsoluteUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new PolicyViolationError(`Invalid target URL: ${value}`);
  }
}

function assertNoEmbeddedCredentials(url: URL): void {
  if (url.username || url.password) {
    throw new PolicyViolationError("Target URLs must not contain credentials.");
  }
}

function assertSupportedProtocol(url: URL, allowInsecureHttp: boolean): void {
  if (!isSupportedProtocol(url, allowInsecureHttp)) {
    throw new PolicyViolationError(
      "Only HTTPS targets are allowed unless allowInsecureHttp is explicitly enabled for a test environment.",
    );
  }
}

function isSupportedProtocol(url: URL, allowInsecureHttp: boolean): boolean {
  return url.protocol === "https:" || (allowInsecureHttp && url.protocol === "http:");
}

export function isPotentiallyDestructivePath(url: URL): boolean {
  const searchable = `${url.pathname}${url.search}`.toLowerCase();
  return DANGEROUS_PATH_PARTS.some((part) => searchable.includes(part));
}
