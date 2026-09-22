import { z } from "zod";

/**
 * A Project groups one or more Application Test Maps under a single
 * name — e.g. "Checkout Team" or "Internal Tools" — so an operator with
 * several applications under test doesn't have to hunt through a flat
 * list of unrelated maps. Nova never infers a project on its own: an
 * operator creates one explicitly, then every application discovered
 * from that point is added inside it (`ApplicationTestMap.projectId`).
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;
