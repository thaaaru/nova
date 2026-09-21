import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { existsSync } from "node:fs";

import type { ApplicationTestMap } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
import { discoverMap, type DiscoverMapResult } from "../../services/testmap/map-service.js";
import {
  ENVIRONMENT_CHOICES,
  deriveApplicationName,
  deriveDefaultEnvironment,
  normalizeTargetUrl,
} from "../../services/testmap/discover-input-rules.js";
import { palette } from "../theme/palette.js";

type Step = "targetUrl" | "name" | "environment" | "authChoice" | "storageStatePath" | "confirm";

const AUTH_CHOICES = [
  { label: "No — public pages only", value: "public" as const },
  { label: "Yes — use a session saved via `nova login`", value: "authenticated" as const },
];

/**
 * Presentational label sequence shown while the one real, non-streaming
 * `discoverMap` call is in flight — same pacing convention as
 * DiscoveryScreen for the legacy plain-run pipeline. The summary shown
 * afterwards always comes from the real DiscoverMapResult.
 */
const DISCOVERY_LABELS = [
  "Connecting to target",
  "Checking approved scope",
  "Mapping pages",
  "Identifying forms and actions",
  "Drafting areas and journeys",
];
const LABEL_INTERVAL_MS = 700;

type MapDiscoverScreenProps = {
  runtime: NovaRuntime;
  onComplete: (map: ApplicationTestMap) => void;
  onCancel: () => void;
};

/**
 * Step 1 of the Application Test Map flow, reachable from inside the TUI —
 * previously an operator had to leave the TUI and run `nova map discover`
 * on the command line. This screen collects a target URL, an application
 * name (defaulted from the hostname), an environment (defaulted from the
 * hostname), and — optionally — an existing session captured by
 * `nova login`, then calls the same `discoverMap` service the CLI command
 * calls and lands the operator straight back in the map they just built.
 *
 * No credential is ever entered here: authenticated scans reuse a
 * storage-state file the operator already produced by hand with
 * `nova login`, consistent with Nova never touching raw credentials.
 */
export function MapDiscoverScreen({
  runtime,
  onComplete,
  onCancel,
}: MapDiscoverScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>("targetUrl");
  const [targetUrl, setTargetUrl] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [applicationName, setApplicationName] = useState("");
  const [environment, setEnvironment] = useState<(typeof ENVIRONMENT_CHOICES)[number]["value"]>("staging");
  const [storageStatePath, setStorageStatePath] = useState<string | undefined>(undefined);
  const [storageStateDraft, setStorageStateDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<"form" | "discovering" | "done" | "error">("form");
  const [labelIndex, setLabelIndex] = useState(0);
  const [result, setResult] = useState<DiscoverMapResult | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const cancelledRef = useRef(false);

  useInput((_input, key) => {
    if (key.escape) {
      cancelledRef.current = true;
      onCancel();
    }
  });

  function submitTargetUrl(raw: string): void {
    const normalized = normalizeTargetUrl(raw);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    setError(undefined);
    setTargetUrl(normalized.value);
    const derivedName = deriveApplicationName(normalized.value) ?? "";
    setNameDraft(derivedName);
    setEnvironment(deriveDefaultEnvironment(normalized.value));
    setStep("name");
  }

  function submitName(raw: string): void {
    const trimmed = raw.trim();
    setError(undefined);
    setApplicationName(trimmed);
    setStep("environment");
  }

  function submitStorageStatePath(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      setError("Enter the path saved by `nova login`, or press Esc to cancel.");
      return;
    }
    if (!existsSync(trimmed)) {
      setError(`No file found at ${trimmed}. Run \`nova login\` first, or Esc to cancel.`);
      return;
    }
    setError(undefined);
    setStorageStatePath(trimmed);
    setStep("confirm");
  }

  useEffect(() => {
    if (phase !== "discovering") {
      return;
    }
    const labelTimer = setInterval(() => {
      setLabelIndex((previous) => Math.min(previous + 1, DISCOVERY_LABELS.length - 1));
    }, LABEL_INTERVAL_MS);

    async function run(): Promise<void> {
      try {
        const discovered = await discoverMap(runtime, {
          target: targetUrl,
          applicationName,
          environment,
          storageStatePath,
        });
        clearInterval(labelTimer);
        if (cancelledRef.current) {
          return;
        }
        setLabelIndex(DISCOVERY_LABELS.length - 1);
        setResult(discovered);
        setPhase("done");
      } catch (error_) {
        clearInterval(labelTimer);
        if (!cancelledRef.current) {
          setRunError(error_ instanceof Error ? error_.message : String(error_));
          setPhase("error");
        }
      }
    }

    void run();
    return () => {
      clearInterval(labelTimer);
    };
  }, [phase, runtime, targetUrl, applicationName, environment, storageStatePath]);

  if (phase !== "form") {
    const journeyCount = result
      ? result.map.areas.reduce((total, area) => total + area.journeys.length, 0)
      : 0;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.blue}>
          DISCOVER APPLICATION
        </Text>
        {phase === "discovering" ? <Text color={palette.cyan}>{DISCOVERY_LABELS[labelIndex]}…</Text> : null}
        {phase === "error" ? <Text color={palette.red}>Failed: {runError}</Text> : null}
        {phase === "done" && result ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={palette.green}>
              MAP DRAFTED
            </Text>
            <Text>
              {result.map.applicationName} — {result.map.areas.length} area(s), {journeyCount} draft
              journey(s)
            </Text>
            <Text color={palette.muted}>This map is a draft until you review and approve its journeys.</Text>
            <Text color={palette.muted}>[Enter] Explore this map now</Text>
          </Box>
        ) : null}
        {phase === "done" ? (
          <ConfirmContinue onConfirm={() => result && onComplete(result.map)} />
        ) : (
          <Text color={palette.muted}>[Esc] Cancel (stops UI progress; returns to Home)</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        DISCOVER APPLICATION — STEP 1
      </Text>
      {step === "targetUrl" ? (
        <>
          <Text>Target URL</Text>
          <TextInput value={targetDraft} onChange={setTargetDraft} onSubmit={submitTargetUrl} />
        </>
      ) : null}
      {step === "name" ? (
        <>
          <Text>Application name (leave blank to let Nova identify it from the crawl)</Text>
          <TextInput value={nameDraft} onChange={setNameDraft} onSubmit={submitName} />
        </>
      ) : null}
      {step === "environment" ? (
        <>
          <Text>Environment</Text>
          <SelectInput
            items={ENVIRONMENT_CHOICES}
            initialIndex={ENVIRONMENT_CHOICES.findIndex((choice) => choice.value === environment)}
            onSelect={(item) => {
              setEnvironment(item.value);
              setStep("authChoice");
            }}
          />
        </>
      ) : null}
      {step === "authChoice" ? (
        <>
          <Text>Does this application require sign-in?</Text>
          <SelectInput
            items={AUTH_CHOICES}
            onSelect={(item) => {
              if (item.value === "authenticated") {
                setStep("storageStatePath");
              } else {
                setStorageStatePath(undefined);
                setStep("confirm");
              }
            }}
          />
        </>
      ) : null}
      {step === "storageStatePath" ? (
        <>
          <Text>Session file saved by `nova login` (--save-storage-state path)</Text>
          <TextInput
            value={storageStateDraft}
            onChange={setStorageStateDraft}
            onSubmit={submitStorageStatePath}
          />
        </>
      ) : null}
      {step === "confirm" ? (
        <>
          <Text>
            Crawl <Text color={palette.cyan}>{targetUrl}</Text>
            {applicationName ? (
              <>
                {" "}
                as <Text color={palette.cyan}>{applicationName}</Text>
              </>
            ) : (
              <> — Nova will identify the application from the crawl</>
            )}{" "}
            ({environment})
            {storageStatePath ? (
              <>
                {" "}
                signed in via <Text color={palette.cyan}>{storageStatePath}</Text>
              </>
            ) : null}
            ?
          </Text>
          <ConfirmContinue onConfirm={() => setPhase("discovering")} />
        </>
      ) : null}
      {error ? <Text color={palette.red}>{error}</Text> : null}
      <Text color={palette.muted}>[Esc] Cancel</Text>
    </Box>
  );
}

function ConfirmContinue({ onConfirm }: { onConfirm: () => void }): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) {
      onConfirm();
    }
  });
  return <Text color={palette.muted}>[Enter] Continue</Text>;
}
