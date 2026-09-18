import { z } from "zod";

export const DiscoveredFormSchema = z.object({
  selector: z.string(),
  action: z.string().optional(),
  method: z.string().optional(),
  fields: z.array(z.object({ name: z.string().optional(), type: z.string().optional() })),
});
export type DiscoveredForm = z.infer<typeof DiscoveredFormSchema>;

export const DiscoveredControlSchema = z.object({
  kind: z.enum(["button", "link"]),
  text: z.string(),
  href: z.string().optional(),
});
export type DiscoveredControl = z.infer<typeof DiscoveredControlSchema>;

export const DiscoveredPageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  forms: z.array(DiscoveredFormSchema),
  buttons: z.array(DiscoveredControlSchema),
  links: z.array(DiscoveredControlSchema),
  consoleErrors: z.array(z.string()),
});
export type DiscoveredPage = z.infer<typeof DiscoveredPageSchema>;

/**
 * Lightweight application map produced by the discover node. Deliberately
 * shallow (no auth, no interaction) — enough for a human or a template to
 * write a TestPlan against, not a full crawl.
 */
export const DiscoverySnapshotSchema = z.object({
  runId: z.string().uuid(),
  targetUrl: z.string().url(),
  visitedUrls: z.array(z.string().url()),
  pages: z.array(DiscoveredPageSchema),
  apiEndpoints: z.array(z.string()),
  capturedAt: z.string().datetime(),
});
export type DiscoverySnapshot = z.infer<typeof DiscoverySnapshotSchema>;
