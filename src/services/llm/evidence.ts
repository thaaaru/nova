import type {
  ApplicationEvidencePackage,
  DiscoveredPage,
  DiscoverySnapshot,
  EvidenceItem,
  EvidenceSourceType,
} from "../../domain/index.js";
import { ApplicationEvidencePackageSchema } from "../../domain/index.js";
import { sha256Of } from "../hash.js";
import { looksSecretBearing, normalizeText } from "./sanitize.js";

/**
 * Turns what discovery actually observed into the bounded, labelled,
 * sanitized `ApplicationEvidencePackage` that is the *only* thing the
 * identification model ever sees. Nothing reaches this package that was
 * not observed: no raw DOM, no script/style content, no hidden text, no
 * cookies, storage, headers, or credentials — those are never collected
 * by `discoverApplication` in the first place, and anything that still
 * looks secret-bearing is dropped here rather than masked.
 *
 * Every item gets a stable `E-nnn` id so the model's claims can be
 * checked against real observations afterwards, in code.
 */

const MAX_ITEM_CONTENT = 300;
const MAX_ITEMS = 120;
const MAX_TOTAL_CHARS = 24_000;
const MAX_PAGES = 30;

export type DocumentEvidenceInput = {
  sourceType: Extract<
    EvidenceSourceType,
    | "documentation"
    | "openapi"
    | "sitemap"
    | "help-page"
    | "api-operation"
    | "project-document"
    | "confirmed-project-info"
  >;
  source: string;
  content: string;
};

export type BuildEvidenceOptions = {
  runId: string;
  snapshot: DiscoverySnapshot;
  /** Public docs, OpenAPI summaries, sitemap entries, previously confirmed project facts. */
  documents?: DocumentEvidenceInput[];
  /** Reason the auth probe gave, when the target sits behind a sign-in wall. */
  authenticationReason?: string;
};

type Candidate = { sourceType: EvidenceSourceType; source: string; content: string };

export function buildEvidencePackage(options: BuildEvidenceOptions): ApplicationEvidencePackage {
  const { snapshot } = options;
  const candidates: Candidate[] = [];

  candidates.push({
    sourceType: "hostname",
    source: snapshot.targetUrl,
    content: new URL(snapshot.targetUrl).hostname,
  });

  if (options.authenticationReason) {
    candidates.push({
      sourceType: "login-characteristic",
      source: snapshot.targetUrl,
      content: options.authenticationReason,
    });
  }

  for (const page of snapshot.pages.slice(0, MAX_PAGES)) {
    candidates.push(...pageCandidates(page));
  }

  for (const route of routePatterns(snapshot)) {
    candidates.push({ sourceType: "route-pattern", source: snapshot.targetUrl, content: route });
  }

  for (const endpoint of snapshot.apiEndpoints.slice(0, 20)) {
    candidates.push({ sourceType: "api-operation", source: endpoint, content: endpoint });
  }

  for (const document of options.documents ?? []) {
    candidates.push({
      sourceType: document.sourceType,
      source: document.source,
      content: document.content,
    });
  }

  return finalize(options.runId, snapshot, candidates);
}

function pageCandidates(page: DiscoveredPage): Candidate[] {
  const out: Candidate[] = [];
  const path = safePath(page.url);
  if (page.title) {
    out.push({ sourceType: "page-title", source: path, content: page.title });
  }
  // Discovery records link/button text, not a DOM tree — nav labels are
  // the repeated, short link texts, and headings are approximated by the
  // longer ones. Both are already plain strings, never markup.
  for (const link of page.links.slice(0, 12)) {
    if (link.text.trim().length > 0) {
      out.push({ sourceType: "nav-label", source: path, content: link.text });
    }
  }
  for (const button of page.buttons.slice(0, 12)) {
    if (button.text.trim().length > 0) {
      out.push({ sourceType: "page-heading", source: path, content: button.text });
    }
  }
  for (const form of page.forms.slice(0, 6)) {
    const labels = form.fields
      .map((field) => field.name)
      .filter((name): name is string => Boolean(name && name.trim().length > 0));
    if (labels.length > 0) {
      out.push({ sourceType: "form-label", source: path, content: labels.join(", ") });
    }
    if (form.fields.some((field) => field.type === "password")) {
      out.push({ sourceType: "login-characteristic", source: path, content: "password field present" });
    }
  }
  return out;
}

/** The distinct first path segments the crawl actually visited — the shape of the app's routing, nothing more. */
function routePatterns(snapshot: DiscoverySnapshot): string[] {
  const segments = new Set<string>();
  for (const url of snapshot.visitedUrls) {
    const first = safePath(url).split("/").filter(Boolean)[0];
    if (first) {
      segments.add(`/${first}`);
    }
  }
  return [...segments].slice(0, 20);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/**
 * Applies the per-item and total-size budgets, drops secret-bearing and
 * duplicate content, assigns stable ids, and hashes the result. The hash
 * is computed over exactly what will be sent, so a cache hit guarantees
 * the model would have seen an identical package.
 */
function finalize(
  runId: string,
  snapshot: DiscoverySnapshot,
  candidates: Candidate[],
): ApplicationEvidencePackage {
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  let redactedItemCount = 0;
  let truncated = false;
  let totalChars = 0;

  for (const candidate of candidates) {
    const content = normalizeText(candidate.content);
    if (content.length === 0) {
      continue;
    }
    if (looksSecretBearing(content)) {
      redactedItemCount += 1;
      continue;
    }
    const clipped =
      content.length > MAX_ITEM_CONTENT ? `${content.slice(0, MAX_ITEM_CONTENT - 1)}…` : content;
    if (clipped.length < content.length) {
      truncated = true;
    }
    const key = `${candidate.sourceType}|${candidate.source}|${clipped}`;
    if (seen.has(key)) {
      continue;
    }
    if (items.length >= MAX_ITEMS || totalChars + clipped.length > MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    seen.add(key);
    totalChars += clipped.length;
    items.push({
      evidenceId: `E-${String(items.length + 1).padStart(3, "0")}`,
      sourceType: candidate.sourceType,
      source: normalizeText(candidate.source).slice(0, 300) || "/",
      content: clipped,
    });
  }

  const evidenceHash = sha256Of({ targetUrl: snapshot.targetUrl, items });
  return ApplicationEvidencePackageSchema.parse({
    runId,
    targetUrl: snapshot.targetUrl,
    capturedAt: snapshot.capturedAt,
    items,
    evidenceHash,
    truncated,
    redactedItemCount,
  });
}

/**
 * Renders the package for the prompt. Each item is individually labelled
 * and delimited so the model can cite it, and so nothing inside an item
 * can be mistaken for part of the surrounding instructions.
 */
export function renderEvidenceForPrompt(evidence: ApplicationEvidencePackage): string {
  return evidence.items
    .map(
      (item) =>
        `<evidence id="${item.evidenceId}" type="${item.sourceType}" source="${item.source}">${item.content}</evidence>`,
    )
    .join("\n");
}
