import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { join } from "node:path";
import { dirname } from "node:path";

import type { ApprovedPlanSnapshot, TestRunState } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
import type { ExecutionResultSummary } from "../../cli/commands.js";
import {
  advanceGuidedRun,
  chooseAuthentication,
  confirmIdentification,
  recordApprovalDecision,
  requestExecution,
  setObjective,
  startGuidedRun,
} from "../../cli/commands.js";
import { startApprovalServer } from "../../services/approval/server.js";
import { captureStorageState } from "../../services/browser/login.js";
import {
  ENVIRONMENT_CHOICES,
  deriveDefaultEnvironment,
  normalizeTargetUrl,
} from "../../services/testmap/discover-input-rules.js";
import { useSettledInput } from "../hooks/useSettledInput.js";
import { openPathWithOsOpener } from "../services/open-path.js";
import { palette } from "../theme/palette.js";

/**
 * The guided end-to-end flow: one screen, one primary action at a time,
 * driving the same LangGraph workflow the CLI drives. Every transition
 * here is a call into src/cli/commands.ts — this component never
 * reimplements discovery, identification, planning, approval, or
 * execution logic, and it never decides anything the workflow's policy
 * layer is responsible for.
 *
 * Progressive disclosure is the whole design: the operator sees the
 * stage they are in, the one action that moves it forward, and nothing
 * else unless they ask for detail. LangGraph node names never appear.
 */

type Phase =
  | "target"
  | "environment"
  | "working"
  | "authentication"
  | "signing-in"
  | "identification"
  | "identification-edit"
  | "evidence"
  | "objective"
  | "plan-ready"
  | "awaiting-approval"
  | "changes-requested"
  | "rejected"
  | "execution-request"
  | "exclusions"
  | "error";

export type TestFlowScreenProps = {
  runtime: NovaRuntime;
  /** Supplied by `nova test <url>`; omitted for a bare `nova`, which asks. */
  presetTarget?: string;
  /** Resume an interrupted run instead of starting a new one. */
  resumeRun?: TestRunState;
  reviewer: string;
  /**
   * Hands the approved run to the live execution screen *along with the
   * work itself*. The guided flow deliberately does not run the tests and
   * then show a finished screen: the execution request is made inside
   * this executor, so the operator watches it happen.
   */
  onExecute: (run: TestRunState, executor: () => Promise<ExecutionResultSummary>) => void;
  onCancel: () => void;
};

const AUTH_CHOICES = [
  { label: "Sign in using browser", value: "browser" },
  { label: "Use saved authentication profile", value: "profile" },
  { label: "Discover public areas only", value: "public" },
];

export function TestFlowScreen({
  runtime,
  presetTarget,
  resumeRun,
  reviewer,
  onExecute,
  onCancel,
}: TestFlowScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>(() => {
    if (resumeRun) return "working";
    return presetTarget ? "environment" : "target";
  });
  const [run, setRun] = useState<TestRunState | undefined>(resumeRun);
  const [targetUrl, setTargetUrl] = useState(presetTarget ?? "");
  const [targetDraft, setTargetDraft] = useState("");
  const [environment, setEnvironment] = useState(() =>
    presetTarget ? deriveDefaultEnvironment(presetTarget) : "staging",
  );
  const [objectiveDraft, setObjectiveDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [purposeDraft, setPurposeDraft] = useState("");
  const [editField, setEditField] = useState<"name" | "purpose">("name");
  const [status, setStatus] = useState("Starting...");
  const [error, setError] = useState<string | undefined>(undefined);
  const [approvalUrl, setApprovalUrl] = useState<string | undefined>(undefined);
  const [loginWaiting, setLoginWaiting] = useState(false);
  const loginResolverRef = useRef<(() => void) | null>(null);
  const [pendingStart, setPendingStart] = useState(false);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  /** One place decides which phase a persisted run puts the operator in — the run's own status. */
  function routeTo(next: TestRunState): void {
    setRun(next);
    switch (next.status) {
      case "authentication_required":
        setPhase("authentication");
        return;
      case "identification_confirmation":
        setPhase("identification");
        return;
      case "planning":
        setPhase(next.objective ? "working" : "objective");
        return;
      case "awaiting_approval":
        setPhase("plan-ready");
        return;
      case "approved":
        setPhase("execution-request");
        return;
      case "changes_requested":
        setPhase("changes-requested");
        return;
      case "rejected":
        setPhase("rejected");
        return;
      case "blocked":
      case "failed":
        setPhase("error");
        setError(`Nova stopped: the run is "${next.status}".`);
        return;
      default:
        setPhase("working");
    }
  }

  async function guard(label: string, work: () => Promise<TestRunState>): Promise<void> {
    setStatus(label);
    setPhase("working");
    try {
      routeTo(await work());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase("error");
    }
  }

  // Kicks off (or resumes) the workflow once the target and environment are known.
  useEffect(() => {
    if (!pendingStart) {
      return;
    }
    setPendingStart(false);
    void guard("Probing the target...", () =>
      startGuidedRun(runtime, {
        target: targetUrl,
        environment,
        runExecutionMode: environment === "production" ? "observe" : "safe_test",
      }),
    );
  }, [pendingStart]);

  useEffect(() => {
    if (resumeRun) {
      void guard("Resuming...", async () => advanceGuidedRun(runtime, resumeRun));
    }
  }, []);

  // Browser sign-in: a real headed browser, captured through the same
  // secure path `nova login` uses. This screen never sees a credential.
  useEffect(() => {
    if (phase !== "signing-in" || !run) {
      return;
    }
    let cancelled = false;
    const outputPath = join(dirname(runtime.config.databasePath), "sessions", `${run.runId}.json`);
    captureStorageState({
      url: run.targetManifest.baseUrl,
      outputPath,
      waitForOperator: () =>
        new Promise<void>((resolve) => {
          if (cancelled) {
            resolve();
            return;
          }
          setLoginWaiting(true);
          loginResolverRef.current = resolve;
        }),
    })
      .then((captured) => {
        if (cancelled) return;
        setLoginWaiting(false);
        void guard("Continuing as the signed-in user...", () =>
          chooseAuthentication(runtime, run.runId, "browser_session", captured.outputPath),
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("error");
      });
    return () => {
      cancelled = true;
      loginResolverRef.current?.();
      loginResolverRef.current = null;
    };
  }, [phase]);

  useInput(
    (_input, key) => {
      if (key.return) {
        loginResolverRef.current?.();
        loginResolverRef.current = null;
      }
    },
    { isActive: phase === "signing-in" && loginWaiting },
  );

  // The approval review: Nova serves its own page on loopback, opens it,
  // and waits. Approval records a decision; it never starts a run.
  useEffect(() => {
    if (phase !== "awaiting-approval" || !run) {
      return;
    }
    let cancelled = false;
    let close: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        const server = await startApprovalServer({ run, reviewer });
        close = server.close;
        if (cancelled) {
          await server.close();
          return;
        }
        setApprovalUrl(server.url);
        openPathWithOsOpener(server.url);
        const snapshot: ApprovedPlanSnapshot | undefined = await server.decision;
        if (cancelled || !snapshot) {
          return;
        }
        await guard("Recording the decision...", () => recordApprovalDecision(runtime, run.runId, snapshot));
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      void close?.();
    };
  }, [phase]);

  const identification = run?.identification;
  const suggestions = run?.suggestions;
  const snapshot = run?.discoverySnapshot;

  if (phase === "target") {
    return (
      <Panel title="TARGET">
        <Text>Which application should Nova test?</Text>
        <TextInput
          value={targetDraft}
          onChange={setTargetDraft}
          onSubmit={(raw) => {
            const normalized = normalizeTargetUrl(raw);
            if (!normalized.ok) {
              setError(normalized.error);
              return;
            }
            setError(undefined);
            setTargetUrl(normalized.value);
            setEnvironment(deriveDefaultEnvironment(normalized.value));
            setPhase("environment");
          }}
        />
        {error ? <Text color={palette.red}>{error}</Text> : null}
        <Hint>[Enter] Continue · [Esc] Cancel</Hint>
      </Panel>
    );
  }

  if (phase === "environment") {
    return (
      <Panel title="ENVIRONMENT">
        <Text>
          Target <Text color={palette.cyan}>{targetUrl}</Text>
        </Text>
        <SelectInput
          items={ENVIRONMENT_CHOICES}
          initialIndex={ENVIRONMENT_CHOICES.findIndex((choice) => choice.value === environment)}
          onSelect={(item) => {
            setEnvironment(item.value);
            setPendingStart(true);
          }}
        />
        <Hint>[Enter] Select · [Esc] Cancel</Hint>
      </Panel>
    );
  }

  if (phase === "authentication" && run) {
    return (
      <Panel title="AUTHENTICATION">
        <Text>
          This application requires sign-in
          {run.authenticationReason ? <Text color={palette.muted}> ({run.authenticationReason})</Text> : null}
          .
        </Text>
        <SelectInput
          items={AUTH_CHOICES}
          onSelect={(item) => {
            if (item.value === "browser") {
              setPhase("signing-in");
              return;
            }
            if (item.value === "profile") {
              const saved = run.targetManifest.storageStatePath;
              if (!saved) {
                setError("No saved authentication profile matches this project and environment yet.");
                return;
              }
              void guard("Reusing the saved profile...", () =>
                chooseAuthentication(runtime, run.runId, "saved_profile", saved),
              );
              return;
            }
            void guard("Discovering public areas only...", () =>
              chooseAuthentication(runtime, run.runId, "public_only"),
            );
          }}
        />
        {error ? <Text color={palette.red}>{error}</Text> : null}
        <Hint>[Esc] Cancel</Hint>
      </Panel>
    );
  }

  if (phase === "signing-in") {
    return (
      <Panel title="SIGN IN">
        {loginWaiting ? (
          <>
            <Text color={palette.cyan}>Sign in in the browser window that just opened.</Text>
            <Hint>[Enter] I&apos;m signed in — capture this session</Hint>
          </>
        ) : (
          <Text color={palette.cyan}>Opening a browser…</Text>
        )}
        <Text color={palette.muted}>
          Nova stores only the resulting session, encrypted. It never sees or records a password.
        </Text>
      </Panel>
    );
  }

  if (phase === "identification" && identification) {
    const value = identification.identification;
    const lowConfidence = value.confidence < 0.6 || identification.source === "degraded";
    return (
      <Panel title="NOVA IDENTIFIED THE APPLICATION">
        <Field label="Name" value={value.applicationName} />
        <Field label="Type" value={value.applicationType} />
        <Field label="Purpose" value={value.primaryPurpose} />
        <Field
          label="Personas"
          value={value.likelyPersonas.map((persona) => persona.name).join(", ") || "—"}
        />
        <Field label="Confidence" value={`${Math.round(value.confidence * 100)}%`} />
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.muted}>
            Evidence {value.evidenceRefs.length} supporting observations · Unknowns {value.unknowns.length}{" "}
            unresolved items
          </Text>
          {lowConfidence ? (
            <Text color={palette.amber}>
              Low confidence — confirm or edit this before Nova maps the application.
            </Text>
          ) : null}
        </Box>
        <IdentificationActions
          allowDefaultContinue={!lowConfidence}
          onContinue={() =>
            run &&
            void guard("Mapping the application...", () =>
              confirmIdentification(runtime, run.runId, reviewer),
            )
          }
          onEdit={() => {
            setNameDraft(value.applicationName);
            setPurposeDraft(value.primaryPurpose);
            setEditField("name");
            setPhase("identification-edit");
          }}
          onEvidence={() => setPhase("evidence")}
          onReanalyse={() =>
            run &&
            void guard("Re-analysing...", () =>
              advanceGuidedRun(runtime, {
                ...run,
                identification: undefined,
                status: "application_identification",
              }),
            )
          }
        />
      </Panel>
    );
  }

  if (phase === "identification-edit") {
    return (
      <Panel title="EDIT IDENTIFICATION">
        <Text color={palette.muted}>
          Your edit replaces the model's answer and is recorded as operator-authored.
        </Text>
        <Text>Application name</Text>
        <TextInput
          value={nameDraft}
          onChange={setNameDraft}
          focus={editField === "name"}
          onSubmit={() => setEditField("purpose")}
        />
        <Text>Primary purpose</Text>
        <TextInput
          value={purposeDraft}
          onChange={setPurposeDraft}
          focus={editField === "purpose"}
          onSubmit={() => {
            if (!run) {
              return;
            }
            void guard("Saving your identification...", () =>
              confirmIdentification(runtime, run.runId, reviewer, {
                applicationName: nameDraft.trim() || "Unnamed application",
                primaryPurpose: purposeDraft.trim() || "Not described.",
              }),
            );
          }}
        />
        <Hint>[Enter] Next field, then save · [Esc] Cancel</Hint>
      </Panel>
    );
  }

  if (phase === "evidence") {
    return (
      <Panel title="EVIDENCE">
        {(run?.evidencePackage?.items ?? []).slice(0, 15).map((item) => (
          <Text key={item.evidenceId} color={palette.muted}>
            {item.evidenceId} [{item.sourceType}] {item.source} — {item.content.slice(0, 70)}
          </Text>
        ))}
        <BackHint onBack={() => setPhase("identification")} />
      </Panel>
    );
  }

  if (phase === "objective") {
    return (
      <Panel title="WHAT SHOULD THIS RUN TEST?">
        <Text color={palette.muted}>
          {identification?.identification.applicationName ?? targetUrl} — describe the objective.
        </Text>
        <TextInput
          value={objectiveDraft}
          onChange={setObjectiveDraft}
          onSubmit={(raw) => {
            const trimmed = raw.trim();
            if (trimmed.length === 0) {
              setError("Enter an objective, or press Esc to cancel.");
              return;
            }
            setError(undefined);
            if (run) {
              void guard("Generating suggested tests...", () => setObjective(runtime, run.runId, trimmed));
            }
          }}
        />
        {error ? <Text color={palette.red}>{error}</Text> : null}
        <Hint>[Enter] Generate suggested tests · [Esc] Cancel</Hint>
      </Panel>
    );
  }

  if (phase === "plan-ready" && run && suggestions) {
    const sideEffecting = suggestions.accepted.filter((entry) => entry.sideEffect !== "none").length;
    return (
      <Panel title="SUGGESTED TESTS READY">
        <Field label="Application" value={identification?.identification.applicationName ?? targetUrl} />
        <Field label="Suggested" value={String(suggestions.accepted.length)} />
        <Field label="Side-effecting" value={String(sideEffecting)} />
        <Field label="Rejected by validation" value={String(suggestions.rejected.length)} />
        <Field label="Plan hash" value={(run.planHash ?? "").slice(0, 16)} />
        <ConfirmHint
          label="Review and approve in your browser"
          onConfirm={() => setPhase("awaiting-approval")}
        />
      </Panel>
    );
  }

  if (phase === "awaiting-approval") {
    return (
      <Panel title="AWAITING APPROVAL">
        <Text color={palette.cyan}>Review the plan in your browser, then come back here.</Text>
        {approvalUrl ? <Text color={palette.muted}>{approvalUrl}</Text> : null}
        <Text color={palette.muted}>
          Approving records a decision. Nova will not run anything until you ask it to.
        </Text>
        <Hint>[Esc] Cancel this review</Hint>
      </Panel>
    );
  }

  if (phase === "changes-requested" && run) {
    return (
      <Panel title="CHANGES REQUESTED">
        <Text>Nova cleared the previous decision and will regenerate the plan.</Text>
        <ConfirmHint
          label="Regenerate suggested tests"
          onConfirm={() => void guard("Revising the plan...", () => advanceGuidedRun(runtime, run))}
        />
      </Panel>
    );
  }

  if (phase === "rejected") {
    return (
      <Panel title="PLAN REJECTED">
        <Text>Nothing was run. The decision is recorded in this run&apos;s audit trail.</Text>
        <BackHint onBack={onCancel} label="Return to Home" />
      </Panel>
    );
  }

  if (phase === "execution-request" && run?.approvedPlanSnapshot) {
    const approval = run.approvedPlanSnapshot;
    const sideEffecting = (run.testPlan?.cases ?? []).filter(
      (testCase) =>
        approval.selectedTestCaseIds.includes(testCase.id) && testCase.executionMode === "state_changing",
    ).length;
    return (
      <Panel title="TEST PLAN APPROVED">
        <Field label="Approved" value={String(approval.selectedTestCaseIds.length)} />
        <Field label="Excluded" value={String(approval.excludedTestCaseIds.length)} />
        <Field label="Side-effecting" value={String(sideEffecting)} />
        <Field label="Approval" value={approval.approvalId} />
        <Field label="Target" value={approval.target} />
        <Field label="Environment" value={approval.environment} />
        <ExecutionActions
          onRun={() =>
            onExecute(run, async () => {
              // Preflight and execution both happen inside this call, on
              // the live screen, so progress is visible rather than
              // finishing invisibly before the screen even mounts.
              const finished = await requestExecution(runtime, run.runId, reviewer);
              return {
                runId: finished.runId,
                status: finished.status,
                classificationCounts: finished.verificationResults.reduce<Record<string, number>>(
                  (counts, verification) => {
                    counts[verification.classification] = (counts[verification.classification] ?? 0) + 1;
                    return counts;
                  },
                  {},
                ),
              };
            })
          }
          onReviewExclusions={() => setPhase("exclusions")}
          onSaveForLater={onCancel}
        />
      </Panel>
    );
  }

  if (phase === "exclusions" && run?.approvedPlanSnapshot) {
    return (
      <Panel title="EXCLUDED FROM THIS RUN">
        {run.approvedPlanSnapshot.excludedTestCaseIds.length === 0 ? (
          <Text color={palette.muted}>Nothing was excluded.</Text>
        ) : (
          run.approvedPlanSnapshot.excludedTestCaseIds.map((id) => (
            <Text key={id} color={palette.muted}>
              {id} — {run.testPlan?.cases.find((testCase) => testCase.id === id)?.title ?? ""}
            </Text>
          ))
        )}
        <BackHint onBack={() => setPhase("execution-request")} />
      </Panel>
    );
  }

  if (phase === "error") {
    return (
      <Panel title="STOPPED">
        <Text color={palette.red}>{error}</Text>
        <BackHint onBack={onCancel} label="Return to Home" />
      </Panel>
    );
  }

  return (
    <Panel title="NOVA">
      <Text color={palette.cyan}>{status}</Text>
      {snapshot ? (
        <Text color={palette.muted}>
          Pages {snapshot.pages.length} · API operations {snapshot.apiEndpoints.length} · Evidence{" "}
          {run?.evidencePackage?.items.length ?? 0}
        </Text>
      ) : null}
      <Hint>[Esc] Cancel</Hint>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Text>
      <Text color={palette.muted}>{label.padEnd(16)}</Text>
      {value}
    </Text>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return <Text color={palette.muted}>{children}</Text>;
}

function ConfirmHint({ label, onConfirm }: { label: string; onConfirm: () => void }): React.ReactElement {
  useSettledInput((_input, key) => {
    if (key.return) {
      onConfirm();
    }
  });
  return <Hint>[Enter] {label}</Hint>;
}

function BackHint({ onBack, label = "Back" }: { onBack: () => void; label?: string }): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) {
      onBack();
    }
  });
  return <Hint>[Enter] {label}</Hint>;
}

function IdentificationActions(props: {
  allowDefaultContinue: boolean;
  onContinue: () => void;
  onEdit: () => void;
  onEvidence: () => void;
  onReanalyse: () => void;
}): React.ReactElement {
  // Guarded: confirming an identification is a governance gate, and a
  // buffered keystroke must never pass it on the operator's behalf.
  useSettledInput((input, key) => {
    if (key.return) {
      props.onContinue();
      return;
    }
    const pressed = input.toLowerCase();
    if (pressed === "e") props.onEdit();
    else if (pressed === "v") props.onEvidence();
    else if (pressed === "r") props.onReanalyse();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Hint>
        {props.allowDefaultContinue
          ? "[Enter] Continue with this identification"
          : "[Enter] Continue anyway (low confidence)"}
      </Hint>
      <Hint>[E] Edit identification · [V] Review evidence · [R] Re-analyse · [Esc] Cancel</Hint>
    </Box>
  );
}

function ExecutionActions(props: {
  onRun: () => void;
  onReviewExclusions: () => void;
  onSaveForLater: () => void;
}): React.ReactElement {
  // Guarded for the same reason, and more so: Enter here starts a run.
  useSettledInput((input, key) => {
    if (key.return) {
      props.onRun();
      return;
    }
    const pressed = input.toLowerCase();
    if (pressed === "e") props.onReviewExclusions();
    else if (pressed === "s") props.onSaveForLater();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Hint>[Enter] Run approved tests</Hint>
      <Hint>[E] Review exclusions · [S] Save for later · [Esc] Cancel</Hint>
    </Box>
  );
}
