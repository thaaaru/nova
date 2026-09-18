import type { AppSnapshot, TargetPolicy } from "../domain.js";

export type DiscoveryRequest = {
  runId: string;
  targetUrl: string;
  policy: TargetPolicy;
  artifactsDirectory: string;
  headless?: boolean;
  storageStatePath?: string;
};

export interface AppDiscoverer {
  discover(request: DiscoveryRequest): Promise<AppSnapshot>;
}
