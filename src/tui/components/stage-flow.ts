import type { TimelineStageId } from "../../domain/index.js";

export const FLOW_STAGES: Array<{ id: TimelineStageId; label: string }> = [
  { id: "discover", label: "Discover" },
  { id: "plan", label: "Plan" },
  { id: "approval", label: "Approve" },
  { id: "execute", label: "Execute" },
  { id: "verify", label: "Verify" },
  { id: "report", label: "Report" },
];
