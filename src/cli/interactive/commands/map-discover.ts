import { z } from "zod";

import { ApplicationTestMapEnvironmentSchema } from "../../../domain/index.js";
import {
  deriveApplicationName,
  deriveDefaultEnvironment,
  ENVIRONMENT_CHOICES,
  normalizeTargetUrl,
} from "../../../services/testmap/discover-input-rules.js";
import type { FieldSpec, ResolveInputsConfig } from "../resolve-inputs.js";

export const MapDiscoverInputSchema = z.object({
  target: z.string().url(),
  name: z.string().min(1).optional(),
  env: ApplicationTestMapEnvironmentSchema,
});
export type MapDiscoverInput = z.infer<typeof MapDiscoverInputSchema>;

const fields: FieldSpec[] = [
  {
    key: "target",
    flag: "--target",
    label: "Target URL",
    kind: "text",
    parse: (raw) => normalizeTargetUrl(raw),
  },
  {
    key: "name",
    flag: "--name",
    label: "Application name (leave blank to let Nova identify it from the crawl)",
    kind: "text",
    defaultValue: (resolved) => (resolved.target ? deriveApplicationName(resolved.target) : undefined),
    optionalInNonInteractive: true,
    parse: (raw) => {
      const trimmed = raw.trim();
      return trimmed.length > 0
        ? { ok: true, value: trimmed }
        : { ok: false, error: "Enter an application name." };
    },
  },
  {
    key: "env",
    flag: "--env",
    label: "Environment",
    kind: "select",
    choices: () => ENVIRONMENT_CHOICES,
    defaultValue: (resolved) => (resolved.target ? deriveDefaultEnvironment(resolved.target) : "staging"),
    parse: (raw) => {
      const result = ApplicationTestMapEnvironmentSchema.safeParse(raw.trim().toLowerCase());
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: "Environment must be one of local, development, staging, production." };
    },
  },
];

export const mapDiscoverResolveConfig: ResolveInputsConfig = {
  title: "NOVA \u2014 Discover Application",
  fields,
  confirmLabel: "Start discovery?",
  exampleCommand: "nova map discover --target https://teklab.dev --name TekLab --env staging",
};
