import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDiscover, runPlan, type DiscoverResult } from "../../cli/commands.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { GuidedSetupInput, TargetManifest } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

/**
 * Presentational label sequence shown while the one real, non-streaming
 * `runDiscover` call is in flight. Nova's discover node performs a real
 * Playwright crawl, but reports it as a single awaited promise — there is
 * no incremental progress API in commands.ts today. These labels are a
 * client-side pacing effect around that one real call, cancelled the
 * instant the real promise settles; the DISCOVERED SUMMARY shown
 * afterwards always comes from the real DiscoverResult, never fabricated.
 */
const DISCOVERY_LABELS = [
  "Connecting to target",
  "Checking approved scope",
  "Mapping pages",
  "Identifying forms and actions",
  "Collecting console and network evidence",
];
const LABEL_INTERVAL_MS = 700;

type DiscoveryScreenProps = {
  runtime: NovaRuntime;
  input: GuidedSetupInput;
  onComplete: (runId: string) => void;
  onCancel: () => void;
};

export function DiscoveryScreen({
  runtime,
  input,
  onComplete,
  onCancel,
}: DiscoveryScreenProps): React.ReactElement {
  const [labelIndex, setLabelIndex] = useState(0);
  const [phase, setPhase] = useState<"discovering" | "planning" | "done" | "error">("discovering");
  const [result, setResult] = useState<DiscoverResult | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const cancelledRef = useRef(false);

  useInput((_input, key) => {
    if (key.escape) {
      // Best-effort cancellation only: the underlying Playwright discovery
      // call in commands.ts/discoverApplication has no abort signal today,
      // so this stops further *UI* progress and returns Home — it does
      // not actually interrupt the in-flight browser automation.
      cancelledRef.current = true;
      onCancel();
    }
  });

  useEffect(() => {
    const labelTimer = setInterval(() => {
      setLabelIndex((previous) => Math.min(previous + 1, DISCOVERY_LABELS.length - 1));
    }, LABEL_INTERVAL_MS);

    async function run(): Promise<void> {
      try {
        const tempDir = mkdtempSync(join(tmpdir(), "nova-tui-"));
        const manifestPath = join(tempDir, "manifest.json");
        const manifest: TargetManifest = {
          targetId: new URL(input.targetUrl).hostname,
          baseUrl: input.targetUrl,
          allowedDomains: input.allowedDomains,
          environment: input.environment,
          description: `Guided setup for ${input.projectName}`,
          runExecutionMode: input.runExecutionMode,
          createdAt: new Date().toISOString(),
        };
        writeFileSync(manifestPath, JSON.stringify(manifest));

        const discovered = await runDiscover(runtime, { target: input.targetUrl, manifest: manifestPath });
        clearInterval(labelTimer);
        if (cancelledRef.current) {
          return;
        }
        setLabelIndex(DISCOVERY_LABELS.length - 1);
        setResult(discovered);
        setPhase("planning");

        await runPlan(runtime, { objective: input.objective, run: discovered.runId });
        if (cancelledRef.current) {
          return;
        }
        setPhase("done");
        onComplete(discovered.runId);
      } catch (error) {
        clearInterval(labelTimer);
        if (!cancelledRef.current) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setPhase("error");
        }
      }
    }

    void run();
    return () => {
      clearInterval(labelTimer);
      cancelledRef.current = true;
    };
  }, []);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        DISCOVERY
      </Text>
      {phase === "discovering" ? <Text color={palette.cyan}>{DISCOVERY_LABELS[labelIndex]}…</Text> : null}
      {phase === "planning" ? (
        <Text color={palette.cyan}>Discovery complete. Generating test plan…</Text>
      ) : null}
      {phase === "error" ? <Text color={palette.red}>Failed: {errorMessage}</Text> : null}
      {result ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={palette.green}>
            DISCOVERED SUMMARY
          </Text>
          <Text>Pages: {result.pageCount}</Text>
          {result.visitedUrls.slice(0, 8).map((url) => (
            <Text key={url} color={palette.muted}>
              {"  "}
              {url}
            </Text>
          ))}
          {result.visitedUrls.length > 8 ? (
            <Text color={palette.muted}> …and {result.visitedUrls.length - 8} more</Text>
          ) : null}
        </Box>
      ) : null}
      <Text color={palette.muted}>[Esc] Cancel (stops UI progress; returns to Home)</Text>
    </Box>
  );
}
