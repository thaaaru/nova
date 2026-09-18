import { z } from "zod";

import { listJourneys, listMaps } from "../../../services/testmap/map-service.js";
import type { NovaRuntime } from "../../context.js";
import type { FieldSpec, ResolveInputsConfig } from "../resolve-inputs.js";

export const JourneyApproveInputSchema = z.object({
  map: z.string().min(1),
  journeyId: z.string().min(1),
});
export type JourneyApproveInput = z.infer<typeof JourneyApproveInputSchema>;

function mostRecentMapId(runtime: NovaRuntime): string | undefined {
  const maps = [...listMaps(runtime)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return maps[0]?.id;
}

/** Builds the guided fields for `nova journey approve`. Throws early, before any prompt, when nothing needs approval. */
export function buildJourneyApproveFields(runtime: NovaRuntime): FieldSpec[] {
  if (listMaps(runtime).length === 0) {
    throw new Error("No application test maps exist yet. Run `nova map discover` first.");
  }
  return [
    {
      key: "map",
      flag: "--map",
      label: "Application Test Map",
      kind: "select",
      choices: () =>
        listMaps(runtime).map((map) => ({
          label: `${map.applicationName} [${map.environment}] (${map.id})`,
          value: map.id,
        })),
      defaultValue: () => mostRecentMapId(runtime),
      parse: (raw) => {
        const map = listMaps(runtime).find((candidate) => candidate.id === raw.trim());
        return map
          ? { ok: true, value: map.id }
          : { ok: false, error: `Unknown application test map: ${raw}` };
      },
    },
    {
      key: "journeyId",
      flag: "journeyId",
      label: "Journey to approve",
      kind: "select",
      choices: (resolved) => {
        const draftJourneys = listJourneys(runtime, resolved.map ?? "").filter(
          (journey) => journey.status === "draft",
        );
        if (draftJourneys.length === 0) {
          throw new Error("No draft journeys need approval in this map.");
        }
        return draftJourneys.map((journey) => ({ label: journey.name, value: journey.id }));
      },
      parse: (raw, resolved) => {
        const journey = listJourneys(runtime, resolved.map ?? "").find(
          (candidate) => candidate.id === raw.trim(),
        );
        return journey ? { ok: true, value: journey.id } : { ok: false, error: `Unknown journey: ${raw}` };
      },
    },
  ];
}

export function journeyApproveResolveConfig(fields: FieldSpec[]): ResolveInputsConfig {
  return {
    title: "NOVA \u2014 Approve Journey",
    fields,
    confirmLabel: "Approve this journey?",
    exampleCommand: "nova journey approve <journey-id> --map <map-id>",
  };
}
