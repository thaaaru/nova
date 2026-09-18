import { randomUUID } from "node:crypto";

import type { RunEvent, RunEventLevel, TimelineStageId, VerbosityLevel } from "../../domain/index.js";

/**
 * Constructs one entry for the in-session live event feed (see
 * domain/schemas/tui.ts's RunEventSchema). The TUI is the only producer of
 * these — they are a presentation-layer log of what the operator saw,
 * separate from the durable AuditEvent trail written by commands.ts/the
 * graph, which remains the compliance record of record.
 */
export function makeEvent(
  stage: TimelineStageId,
  level: RunEventLevel,
  minVerbosity: VerbosityLevel,
  message: string,
  detail: Record<string, unknown> = {},
): RunEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    stage,
    level,
    minVerbosity,
    message,
    detail,
  };
}
