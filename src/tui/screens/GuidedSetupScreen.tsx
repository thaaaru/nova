import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";

import type { GuidedSetupInput, RunExecutionMode } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type Step = "projectName" | "environment" | "targetUrl" | "allowedDomains" | "runExecutionMode" | "objective";

const STEPS: Step[] = [
  "projectName",
  "environment",
  "targetUrl",
  "allowedDomains",
  "runExecutionMode",
  "objective",
];

const STEP_LABEL: Record<Step, string> = {
  projectName: "Project name",
  environment: "Environment",
  targetUrl: "Target URL",
  allowedDomains: "Approved domains (comma-separated)",
  runExecutionMode: "Execution mode",
  objective: "Objective — what should this run test?",
};

const EXECUTION_MODE_ITEMS: Array<{ label: string; value: RunExecutionMode }> = [
  { label: "Observe (read-only crawl and checks only)", value: "observe" },
  { label: "Safe test (state-changing cases allowed once approved)", value: "safe_test" },
  { label: "Destructive test (high-risk cases allowed once approved)", value: "destructive_test" },
];

function validateStep(step: Step, value: string): string | undefined {
  if (step === "objective" || step === "projectName" || step === "environment") {
    return value.trim().length === 0 ? "This field cannot be empty." : undefined;
  }
  if (step === "targetUrl") {
    try {
      new URL(value);
      return undefined;
    } catch {
      return "Enter a valid URL, e.g. https://staging.example.com";
    }
  }
  if (step === "allowedDomains") {
    const domains = value
      .split(",")
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0);
    return domains.length === 0 ? "Enter at least one domain." : undefined;
  }
  return undefined;
}

type GuidedSetupScreenProps = {
  onSubmit: (input: GuidedSetupInput) => void;
  onCancel: () => void;
  initial?: Partial<GuidedSetupInput>;
};

/**
 * Guided setup: collects a GuidedSetupInput field by field, validating each
 * before advancing, then hands the assembled input to the caller (App),
 * which drives the real runDiscover + runPlan calls on the Discovery
 * screen — this screen never calls them itself. `initial` pre-fills a
 * "begin a new run from this plan" re-entry from the Completion screen.
 */
export function GuidedSetupScreen({
  onSubmit,
  onCancel,
  initial,
}: GuidedSetupScreenProps): React.ReactElement {
  const initialValues: Record<Step, string> = {
    projectName: initial?.projectName ?? "",
    environment: initial?.environment ?? "staging",
    targetUrl: initial?.targetUrl ?? "",
    allowedDomains: initial?.allowedDomains?.join(", ") ?? "",
    runExecutionMode: initial?.runExecutionMode ?? "safe_test",
    objective: initial?.objective ?? "",
  };
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<Step, string>>(initialValues);
  const [draft, setDraft] = useState(initialValues[STEPS[0] ?? "objective"]);
  const [error, setError] = useState<string | undefined>(undefined);

  const step = STEPS[stepIndex] ?? "objective";

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  function advance(rawValue: string): void {
    const validationError = validateStep(step, rawValue);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(undefined);
    const updated = { ...values, [step]: rawValue };
    setValues(updated);
    if (stepIndex + 1 < STEPS.length) {
      setDraft(updated[STEPS[stepIndex + 1] ?? "objective"]);
      setStepIndex(stepIndex + 1);
      return;
    }
    onSubmit({
      projectName: updated.projectName,
      environment: updated.environment,
      targetUrl: updated.targetUrl,
      allowedDomains: updated.allowedDomains
        .split(",")
        .map((domain) => domain.trim())
        .filter((domain) => domain.length > 0),
      runExecutionMode: updated.runExecutionMode as RunExecutionMode,
      objective: updated.objective,
    });
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        GUIDED SETUP ({stepIndex + 1}/{STEPS.length})
      </Text>
      <Text>{STEP_LABEL[step]}</Text>
      {step === "runExecutionMode" ? (
        <SelectInput items={EXECUTION_MODE_ITEMS} onSelect={(item) => advance(item.value)} />
      ) : (
        <TextInput value={draft} onChange={setDraft} onSubmit={advance} />
      )}
      {error ? <Text color={palette.red}>{error}</Text> : null}
      <Text color={palette.muted}>[Enter] Next [Esc] Cancel</Text>
    </Box>
  );
}
