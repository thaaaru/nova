import { z } from "zod";

import { ApplicationTestMapEnvironmentSchema } from "../../../domain/index.js";
import { listJourneys, listMaps } from "../../../services/testmap/map-service.js";
import type { NovaRuntime } from "../../context.js";
import type { FieldSpec, ResolveInputsConfig } from "../resolve-inputs.js";

export const JourneyRunInputSchema = z.object({
  map: z.string().min(1),
  journeyId: z.string().min(1),
  env: ApplicationTestMapEnvironmentSchema,
});
export type JourneyRunInput = z.infer<typeof JourneyRunInputSchema>;

function mostRecentMapId(runtime: NovaRuntime): string | undefined {
  const maps = [...listMaps(runtime)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return maps[0]?.id;
}

/** Builds the guided fields for `nova journey run`. Throws early, before any prompt, when there is nothing runnable. */
export function buildJourneyRunFields(runtime: NovaRuntime): FieldSpec[] {
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
      label: "Journey",
      kind: "select",
      choices: (resolved) => {
        const journeys = listJourneys(runtime, resolved.map ?? "").filter(
          (journey) => journey.status === "approved",
        );
        if (journeys.length === 0) {
          throw new Error(
            `No approved journeys in this map. Run \`nova journey approve <journey-id> --map ${resolved.map}\` first.`,
          );
        }
        return journeys.map((journey) => ({ label: `${journey.name} (${journey.mode})`, value: journey.id }));
      },
      parse: (raw, resolved) => {
        const journey = listJourneys(runtime, resolved.map ?? "").find(
          (candidate) => candidate.id === raw.trim(),
        );
        return journey ? { ok: true, value: journey.id } : { ok: false, error: `Unknown journey: ${raw}` };
      },
    },
    {
      key: "env",
      flag: "--env",
      label: "Environment",
      kind: "text",
      defaultValue: (resolved) => listMaps(runtime).find((map) => map.id === resolved.map)?.environment,
      nonInteractiveDefault: true,
      parse: (raw) => {
        const result = ApplicationTestMapEnvironmentSchema.safeParse(raw.trim().toLowerCase());
        return result.success
          ? { ok: true, value: result.data }
          : { ok: false, error: "Environment must be one of local, development, staging, production." };
      },
    },
  ];
}

export function journeyRunResolveConfig(fields: FieldSpec[]): ResolveInputsConfig {
  return {
    title: "NOVA \u2014 Run Journey",
    fields,
    confirmLabel: "Run this journey?",
    exampleCommand: "nova journey run <journey-id> --map <map-id> --env staging",
  };
}
