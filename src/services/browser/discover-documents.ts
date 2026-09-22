import type { DocumentEvidenceInput } from "../llm/evidence.js";
import { looksSecretBearing, normalizeText } from "../llm/sanitize.js";

/**
 * Looks for the public, machine-readable documentation a web application
 * conventionally publishes about itself. Strictly same-origin, strictly
 * GET, strictly bounded: this is discovery, not a crawler, and it never
 * follows a redirect off the target's own host.
 *
 * Whatever it finds is untrusted application content like any other page
 * — it is summarized into short evidence items here and never handed to
 * a model as raw document text.
 */

const WELL_KNOWN_PATHS: Array<{ path: string; sourceType: DocumentEvidenceInput["sourceType"] }> = [
  { path: "/openapi.json", sourceType: "openapi" },
  { path: "/swagger.json", sourceType: "openapi" },
  { path: "/v3/api-docs", sourceType: "openapi" },
  { path: "/sitemap.xml", sourceType: "sitemap" },
  { path: "/docs", sourceType: "documentation" },
  { path: "/help", sourceType: "help-page" },
];

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

export type DiscoverDocumentsOptions = {
  targetUrl: string;
  allowedDomains: string[];
  onProgress?: (message: string) => void;
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
};

export async function discoverDocuments(options: DiscoverDocumentsOptions): Promise<DocumentEvidenceInput[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = new URL(options.targetUrl).origin;
  const hostname = new URL(options.targetUrl).hostname;
  if (!options.allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return [];
  }

  const found: DocumentEvidenceInput[] = [];
  for (const candidate of WELL_KNOWN_PATHS) {
    const url = `${origin}${candidate.path}`;
    const body = await tryFetch(fetchImpl, url);
    if (!body) {
      continue;
    }
    options.onProgress?.(`Found ${candidate.path}`);
    for (const content of summarize(candidate.sourceType, body)) {
      if (!looksSecretBearing(content)) {
        found.push({ sourceType: candidate.sourceType, source: candidate.path, content });
      }
    }
  }
  return found;
}

async function tryFetch(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    if (!response.ok) {
      return undefined;
    }
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  } catch {
    // A missing, slow, or unreachable document is the normal case, not an error.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Reduces a document to a handful of short, quotable lines — never the whole file. */
function summarize(sourceType: DocumentEvidenceInput["sourceType"], body: string): string[] {
  if (sourceType === "openapi") {
    try {
      const parsed = JSON.parse(body) as {
        info?: { title?: string; description?: string };
        paths?: Record<string, Record<string, { summary?: string }>>;
      };
      const lines: string[] = [];
      if (parsed.info?.title) {
        lines.push(`API title: ${parsed.info.title}`);
      }
      if (parsed.info?.description) {
        lines.push(`API description: ${parsed.info.description}`);
      }
      for (const [path, methods] of Object.entries(parsed.paths ?? {}).slice(0, 25)) {
        const summaries = Object.entries(methods)
          .map(([method, operation]) => `${method.toUpperCase()} ${operation?.summary ?? ""}`.trim())
          .join("; ");
        lines.push(normalizeText(`${path} — ${summaries}`));
      }
      return lines.filter((line) => line.length > 0).slice(0, 30);
    } catch {
      return [];
    }
  }
  if (sourceType === "sitemap") {
    const locations = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    return locations.slice(0, 25).map((location) => normalizeText(location));
  }
  return normalizeText(body)
    .split(". ")
    .filter((sentence) => sentence.length > 20)
    .slice(0, 10);
}
