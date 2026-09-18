import { randomUUID } from "node:crypto";

import type { ApplicationArea, ApplicationTestMap, UserJourney } from "../../domain/index.js";

/**
 * Deterministic keyword-overlap matching — never an LLM call. A natural-
 * language request is tokenized and scored against every journey's own
 * name/description/area name; the highest-scoring journey above a fixed
 * threshold is treated as a match and reused as-is (its checkpoints,
 * personas, fixtures, semantic locators — nothing is re-derived). Below
 * threshold, a guided_test draft is proposed instead of silently
 * fabricating a brand-new automated script.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "when",
  "test",
  "tests",
  "testing",
  "of",
  "to",
  "and",
  "is",
  "that",
  "this",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function overlapScore(requestTokens: Set<string>, candidateTokens: Set<string>): number {
  let hits = 0;
  for (const token of requestTokens) {
    if (candidateTokens.has(token)) {
      hits += 1;
    }
  }
  return requestTokens.size === 0 ? 0 : hits / requestTokens.size;
}

export const MATCH_THRESHOLD = 0.34;

export type NaturalLanguageMatch =
  | { kind: "matched"; area: ApplicationArea; journey: UserJourney; score: number }
  | { kind: "draft"; draftJourney: UserJourney; nearestAreaId: string | undefined; bestScore: number };

/**
 * Matches free text against every approved-or-draft journey already on
 * the map. A close match is returned as-is for reuse; otherwise a
 * guided_test draft journey is synthesized from the request text alone
 * (no steps/checkpoints yet — a QA engineer curates those before it can
 * ever be approved to run), so "describe a test" never masquerades as a
 * fully automated script the instant it's typed.
 */
export function matchNaturalLanguageRequest(
  map: ApplicationTestMap,
  requestText: string,
): NaturalLanguageMatch {
  const requestTokens = tokenize(requestText);

  let best: { area: ApplicationArea; journey: UserJourney; score: number } | undefined;
  for (const area of map.areas) {
    for (const journey of area.journeys) {
      const candidateTokens = tokenize(`${journey.name} ${journey.description} ${area.name}`);
      const score = overlapScore(requestTokens, candidateTokens);
      if (!best || score > best.score) {
        best = { area, journey, score };
      }
    }
  }

  if (best && best.score >= MATCH_THRESHOLD) {
    return { kind: "matched", area: best.area, journey: best.journey, score: best.score };
  }

  const nearestAreaId = findNearestArea(map, requestTokens);
  const draftJourney: UserJourney = {
    id: `draft-${randomUUID()}`,
    areaId: nearestAreaId ?? map.areas[0]?.id ?? "unassigned",
    name: requestText.trim().slice(0, 80),
    description: requestText.trim(),
    mode: "guided_test",
    requiredPersonaIds: [],
    requiredFixtureIds: [],
    checkpoints: [
      {
        id: "checkpoint-draft",
        name: "Describe expected outcome",
        expectedOutcome: "A QA engineer curates concrete checkpoints and steps before this journey can run.",
        riskLevel: "medium",
        requiresApproval: true,
        evidenceRequirements: ["screenshot"],
        steps: [],
        assertions: [],
      },
    ],
    allowedRecoveryActions: [],
    status: "draft",
  };

  return { kind: "draft", draftJourney, nearestAreaId, bestScore: best?.score ?? 0 };
}

function findNearestArea(map: ApplicationTestMap, requestTokens: Set<string>): string | undefined {
  let best: { areaId: string; score: number } | undefined;
  for (const area of map.areas) {
    const score = overlapScore(requestTokens, tokenize(area.name));
    if (score > 0 && (!best || score > best.score)) {
      best = { areaId: area.id, score };
    }
  }
  return best?.areaId;
}
