import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

import { runApprove } from "../../cli/commands.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { TestRunState } from "../../domain/index.js";
import { palette } from "../theme/palette.js";

type Mode = "menu" | "rejectReason" | "rawJson";

const JSON_PAGE_SIZE = 16;

type PlanReviewScreenProps = {
  runtime: NovaRuntime;
  run: TestRunState;
  onApproved: () => void;
  onRejected: () => void;
  onReturnToPlanning: () => void;
  onBack: () => void;
};

/**
 * Renders the real TestPlan for `run` and drives the real `runApprove`
 * call for approve/reject — this screen never fakes an approval decision
 * or the resulting run status.
 */
export function PlanReviewScreen({
  runtime,
  run,
  onApproved,
  onRejected,
  onReturnToPlanning,
  onBack,
}: PlanReviewScreenProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>("menu");
  const [rejectReason, setRejectReason] = useState("");
  const [jsonOffset, setJsonOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const plan = run.testPlan;

  useInput((_input, key) => {
    if (mode === "rawJson") {
      if (key.upArrow) {
        setJsonOffset((offset) => Math.max(0, offset - 1));
      }
      if (key.downArrow) {
        setJsonOffset((offset) => offset + 1);
      }
      if (key.escape) {
        setMode("menu");
      }
    } else if (mode === "menu" && key.escape) {
      onBack();
    }
  });

  if (!plan) {
    return (
      <Box borderStyle="round" borderColor={palette.amber} paddingX={1}>
        <Text color={palette.amber}>No test plan on this run yet.</Text>
      </Box>
    );
  }

  async function approve(): Promise<void> {
    setBusy(true);
    try {
      await runApprove(runtime, { plan: run.runId });
      onApproved();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function reject(reason: string): Promise<void> {
    setBusy(true);
    try {
      await runApprove(runtime, { plan: run.runId, reject: true, note: reason });
      onRejected();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "rejectReason") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.amber} paddingX={1}>
        <Text bold color={palette.amber}>
          REJECT PLAN — reason
        </Text>
        <TextInput value={rejectReason} onChange={setRejectReason} onSubmit={(value) => void reject(value)} />
        <Text color={palette.muted}>[Enter] Submit [Esc] Back</Text>
      </Box>
    );
  }

  if (mode === "rawJson") {
    const lines = JSON.stringify(plan, null, 2).split("\n");
    const page = lines.slice(jsonOffset, jsonOffset + JSON_PAGE_SIZE);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.blue}>
          RAW TEST PLAN JSON ({jsonOffset + 1}-{Math.min(jsonOffset + JSON_PAGE_SIZE, lines.length)} of{" "}
          {lines.length})
        </Text>
        {page.map((line, index) => (
          <Text key={jsonOffset + index}>{line}</Text>
        ))}
        <Text color={palette.muted}>[up/down] Scroll [Esc] Back</Text>
      </Box>
    );
  }

  const items = [
    { label: "Approve plan", value: "approve" },
    { label: "Reject with reason", value: "reject" },
    { label: "Return to planning", value: "replan" },
    { label: "Inspect raw JSON", value: "raw" },
    { label: "Back to Home", value: "back" },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        TEST PLAN REVIEW — {plan.id}
      </Text>
      <Text>Objective: {plan.objective}</Text>
      <Text color={palette.muted}>Approval: {run.approval ? run.approval.decision : "pending"}</Text>
      <Box flexDirection="column" marginY={1}>
        {plan.cases.map((testCase) => (
          <Box key={testCase.id} flexDirection="column" marginBottom={1}>
            <Text bold>{testCase.title}</Text>
            <Text color={palette.muted}>
              {"  "}checkpoints: {testCase.steps.length} steps / {testCase.assertions.length} assertions
              {"  "}risk: <Text color={riskColor(testCase.riskLevel)}>{testCase.riskLevel}</Text>
              {"  "}mode: {testCase.executionMode}
              {"  "}recovery budget: {testCase.recoveryBudget}
            </Text>
          </Box>
        ))}
      </Box>
      {errorMessage ? <Text color={palette.red}>{errorMessage}</Text> : null}
      {busy ? (
        <Text color={palette.cyan}>Working…</Text>
      ) : (
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "approve") {
              void approve();
            } else if (item.value === "reject") {
              setMode("rejectReason");
            } else if (item.value === "replan") {
              onReturnToPlanning();
            } else if (item.value === "raw") {
              setJsonOffset(0);
              setMode("rawJson");
            } else {
              onBack();
            }
          }}
        />
      )}
    </Box>
  );
}

function riskColor(riskLevel: string): string {
  if (riskLevel === "high") {
    return palette.red;
  }
  if (riskLevel === "medium") {
    return palette.amber;
  }
  return palette.green;
}
