import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";

import type { ApplicationTestMap, Project } from "../../domain/index.js";
import type { NovaRuntime } from "../../cli/context.js";
import { discoverMap, type DiscoverMapResult } from "../../services/testmap/map-service.js";
import { createProject, listProjects } from "../../services/testmap/project-service.js";
import {
  listPersonas,
  createPersonaFromLogin,
  createPersonaFromReference,
  reconnectPersona,
  resolvePersonaStorageStatePath,
  personaSessionStatusLabel,
  type PersonaView,
} from "../../services/testmap/project-persona-service.js";
import { detectAuthRequirement } from "../../services/browser/detect-auth.js";
import {
  ENVIRONMENT_CHOICES,
  deriveApplicationName,
  deriveDefaultEnvironment,
  normalizeTargetUrl,
} from "../../services/testmap/discover-input-rules.js";
import { palette } from "../theme/palette.js";

type Step =
  | "project"
  | "projectName"
  | "targetUrl"
  | "name"
  | "environment"
  | "checkingAuth"
  | "personaChoice"
  | "personaName"
  | "personaReference"
  | "signingIn"
  | "confirm";

const CREATE_PROJECT_VALUE = "__create_project__";
const NEW_PERSONA_VALUE = "__new_persona__";
const REFERENCE_PERSONA_VALUE = "__reference_persona__";
const PUBLIC_ONLY_VALUE = "__public_only__";

/**
 * The three real, observable phases of the one non-streaming `discoverMap`
 * call — driven straight from `discoverApplication`'s own `onProgress`
 * messages (never a cosmetic timer), so what the operator sees checking
 * off is what is actually happening: connect, crawl the target, then
 * draft areas/journeys from what was found.
 */
const DISCOVERY_STAGES: Array<{ label: string; matches: (message: string) => boolean }> = [
  { label: "Connect", matches: (message) => message.includes("Launching browser") },
  { label: "Crawl pages", matches: (message) => message.startsWith("Visiting") || message.startsWith("Skipped") },
  { label: "Draft map", matches: (message) => message.startsWith("Drafting") },
];

function currentDiscoveryStageIndex(messages: string[]): number {
  let index = -1;
  for (const message of messages) {
    const matched = DISCOVERY_STAGES.findIndex((stage) => stage.matches(message));
    if (matched > index) {
      index = matched;
    }
  }
  return index;
}

function DiscoveryChecklist({ messages }: { messages: string[] }): React.ReactElement {
  const currentIndex = currentDiscoveryStageIndex(messages);
  const lastMessage = messages[messages.length - 1];
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        {DISCOVERY_STAGES.map((stage, index) => {
          const isPast = index < currentIndex;
          const isCurrent = index === currentIndex;
          const color = isCurrent ? palette.cyan : isPast ? palette.green : palette.muted;
          const glyph = isPast ? "✓" : isCurrent ? "●" : "○";
          return (
            <Text key={stage.label} color={color} bold={isCurrent}>
              {glyph} {stage.label}
            </Text>
          );
        })}
      </Box>
      {lastMessage ? <Text color={palette.muted}>{lastMessage}</Text> : null}
    </Box>
  );
}

type MapDiscoverScreenProps = {
  runtime: NovaRuntime;
  onComplete: (map: ApplicationTestMap) => void;
  onCancel: () => void;
  /** Skips the "which project?" step — set when launched from inside an already-selected project (e.g. Manage projects -> New app). */
  presetProjectId?: string;
};

/**
 * Step 1 of the Application Test Map flow, reachable from inside the TUI —
 * previously an operator had to leave the TUI and run `nova map discover`
 * on the command line. This screen collects a target URL, an application
 * name (defaulted from the hostname), and an environment (defaulted from
 * the hostname), then calls the same `discoverMap` service the CLI
 * command calls and lands the operator straight back in the map they
 * just built.
 *
 * Authentication is never asked upfront: once the target URL is known,
 * Nova probes it (`detectAuthRequirement`) and only surfaces the persona
 * sub-flow — "Use saved persona" / "Sign in in browser now" / "Enter
 * test-account reference" / "Continue without signing in" — when the
 * probe actually finds a sign-in wall. Session material is captured via
 * `createPersonaFromLogin`/`reconnectPersona` (a real headed browser;
 * Nova waits for an Enter keypress in this same TUI before serializing
 * the session) and immediately encrypted into the local session vault —
 * this screen only ever handles a persona name and a computed
 * Ready/Expired/Needs-login status, never a cookie, a token, or a file
 * path.
 */
export function MapDiscoverScreen({
  runtime,
  onComplete,
  onCancel,
  presetProjectId,
}: MapDiscoverScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>(presetProjectId ? "targetUrl" : "project");
  const [projects, setProjects] = useState<Project[]>(() => listProjects(runtime));
  const [projectId, setProjectId] = useState<string | undefined>(presetProjectId);
  const [newProjectDraft, setNewProjectDraft] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [applicationName, setApplicationName] = useState("");
  const [environment, setEnvironment] = useState<(typeof ENVIRONMENT_CHOICES)[number]["value"]>("staging");
  const [storageStatePath, setStorageStatePath] = useState<string | undefined>(undefined);
  const [personaId, setPersonaId] = useState<string | undefined>(undefined);
  const [selectedPersonaName, setSelectedPersonaName] = useState<string | undefined>(undefined);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [authReason, setAuthReason] = useState<string | undefined>(undefined);
  const [personaNameDraft, setPersonaNameDraft] = useState("");
  const [personaReferenceDraft, setPersonaReferenceDraft] = useState("");
  const [pendingPersonaName, setPendingPersonaName] = useState("");
  const [signInIntent, setSignInIntent] = useState<
    { mode: "create" } | { mode: "reconnect"; personaId: string; name: string } | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<"form" | "discovering" | "done" | "error">("form");
  const [progressMessages, setProgressMessages] = useState<string[]>([]);
  const [result, setResult] = useState<DiscoverMapResult | undefined>(undefined);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const [loginStatus, setLoginStatus] = useState<"opening" | "waiting" | "saving" | "error">("opening");
  const [loginError, setLoginError] = useState<string | undefined>(undefined);
  const loginResolverRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);

  useInput((_input, key) => {
    if (key.escape) {
      cancelledRef.current = true;
      onCancel();
    }
  });

  // Runs the real auth probe the moment the target/environment are known
  // — never a blind "does this app require sign-in?" question. A
  // required-auth result routes to the persona sub-flow; otherwise the
  // guided flow proceeds straight to confirm, exactly as an unauthenticated
  // app always should.
  useEffect(() => {
    if (step !== "checkingAuth") {
      return;
    }
    let cancelled = false;
    detectAuthRequirement({ url: targetUrl, headless: runtime.config.headless })
      .then((detected) => {
        if (cancelled) {
          return;
        }
        if (!detected.required) {
          setStorageStatePath(undefined);
          setPersonaId(undefined);
          setSelectedPersonaName(undefined);
          setStep("confirm");
          return;
        }
        setAuthReason(detected.reason);
        setPersonas(projectId ? listPersonas(runtime, projectId) : []);
        setStep("personaChoice");
      })
      .catch(() => {
        // A failed probe never blocks the guided flow — proceed as if no
        // auth is required; the real crawl's own error handling surfaces
        // any actual problem.
        if (!cancelled) {
          setStep("confirm");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [step, targetUrl, runtime, projectId]);

  // Drives both "sign in now" (new persona) and "reconnect" (recapturing
  // an expired/never-signed-in persona's session): opens a real headed
  // browser at the target, then waits for the operator to confirm — via
  // Enter, in this same terminal — before the persona service serializes
  // and encrypts the resulting session. Cleanup always resolves the
  // pending wait so the browser closes even if the operator cancels (Esc)
  // or navigates away mid-login.
  useEffect(() => {
    if (step !== "signingIn" || !signInIntent) {
      return;
    }
    let cancelled = false;
    setLoginStatus("opening");
    setLoginError(undefined);

    const waitForOperator = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (cancelled) {
          resolve();
          return;
        }
        setLoginStatus("waiting");
        loginResolverRef.current = resolve;
      });

    const capture =
      signInIntent.mode === "create"
        ? createPersonaFromLogin(runtime, {
            projectId: projectId as string,
            name: pendingPersonaName,
            url: targetUrl,
            waitForOperator,
            headless: false,
          })
        : reconnectPersona(runtime, {
            personaId: signInIntent.personaId,
            url: targetUrl,
            waitForOperator,
          });

    capture
      .then(({ persona, storageStatePath: capturedPath }) => {
        if (cancelled) {
          return;
        }
        setLoginStatus("saving");
        setPersonaId(persona.id);
        setSelectedPersonaName(persona.name);
        setStorageStatePath(capturedPath);
        setStep("confirm");
      })
      .catch((error_) => {
        if (cancelled) {
          return;
        }
        setLoginError(error_ instanceof Error ? error_.message : String(error_));
        setLoginStatus("error");
      });

    return () => {
      cancelled = true;
      loginResolverRef.current?.();
      loginResolverRef.current = null;
    };
  }, [step, signInIntent, runtime, targetUrl, projectId, pendingPersonaName]);

  useInput(
    (_input, key) => {
      if (key.return) {
        loginResolverRef.current?.();
        loginResolverRef.current = null;
      }
    },
    { isActive: step === "signingIn" && loginStatus === "waiting" },
  );

  function submitProjectName(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      setError("Enter a project name, or press Esc to cancel.");
      return;
    }
    setError(undefined);
    const created = createProject(runtime, { name: trimmed });
    setProjects((previous) => [created, ...previous]);
    setProjectId(created.id);
    setStep("targetUrl");
  }

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

  function submitPersonaReference(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      setError("Enter a test-account reference, or press Esc to cancel.");
      return;
    }
    setError(undefined);
    const created = createPersonaFromReference(runtime, {
      projectId: projectId as string,
      name: pendingPersonaName,
      reference: trimmed,
    });
    setPersonaId(created.id);
    setSelectedPersonaName(created.name);
    setStorageStatePath(undefined);
    setStep("confirm");
  }

  useEffect(() => {
    if (phase !== "discovering") {
      return;
    }
    setProgressMessages([]);

    async function run(): Promise<void> {
      try {
        const discovered = await discoverMap(runtime, {
          target: targetUrl,
          applicationName,
          environment,
          projectId,
          storageStatePath,
          personaId,
          onProgress: (message) => {
            if (!cancelledRef.current) {
              setProgressMessages((previous) => [...previous, message]);
            }
          },
        });
        if (cancelledRef.current) {
          return;
        }
        setResult(discovered);
        setPhase("done");
      } catch (error_) {
        if (!cancelledRef.current) {
          setRunError(error_ instanceof Error ? error_.message : String(error_));
          setPhase("error");
        }
      }
    }

    void run();
  }, [phase, runtime, targetUrl, applicationName, environment, projectId, storageStatePath, personaId]);

  if (phase !== "form") {
    const journeyCount = result
      ? result.map.areas.reduce((total, area) => total + area.journeys.length, 0)
      : 0;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.blue}>
          DISCOVER APPLICATION
        </Text>
        {phase === "discovering" ? (
          <DiscoveryChecklist messages={progressMessages} />
        ) : null}
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

  const personaChoiceItems = [
    ...personas.map((persona) => ({
      label: `${persona.name} — ${personaSessionStatusLabel(persona.sessionStatus)}`,
      value: persona.id,
    })),
    { label: "+ Sign in in browser now", value: NEW_PERSONA_VALUE },
    { label: "Enter test-account reference", value: REFERENCE_PERSONA_VALUE },
    { label: "Continue without signing in (public areas only)", value: PUBLIC_ONLY_VALUE },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.blue}>
        DISCOVER APPLICATION — STEP 1
      </Text>
      {step === "project" ? (
        <>
          <Text>Which project is this application in?</Text>
          <SelectInput
            items={[
              ...projects.map((project) => ({ label: project.name, value: project.id })),
              { label: "+ Create a new project", value: CREATE_PROJECT_VALUE },
            ]}
            onSelect={(item) => {
              if (item.value === CREATE_PROJECT_VALUE) {
                setStep("projectName");
              } else {
                setProjectId(item.value);
                setStep("targetUrl");
              }
            }}
          />
        </>
      ) : null}
      {step === "projectName" ? (
        <>
          <Text>New project name</Text>
          <TextInput value={newProjectDraft} onChange={setNewProjectDraft} onSubmit={submitProjectName} />
        </>
      ) : null}
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
              setStep("checkingAuth");
            }}
          />
        </>
      ) : null}
      {step === "checkingAuth" ? (
        <Text color={palette.cyan}>Checking whether sign-in is required…</Text>
      ) : null}
      {step === "personaChoice" ? (
        <>
          <Text>
            Authentication required{authReason ? <Text color={palette.muted}> ({authReason})</Text> : null}
          </Text>
          <SelectInput
            items={personaChoiceItems}
            onSelect={(item) => {
              if (item.value === NEW_PERSONA_VALUE) {
                setSignInIntent({ mode: "create" });
                setStep("personaName");
                return;
              }
              if (item.value === REFERENCE_PERSONA_VALUE) {
                setSignInIntent(undefined);
                setStep("personaName");
                return;
              }
              if (item.value === PUBLIC_ONLY_VALUE) {
                setStorageStatePath(undefined);
                setPersonaId(undefined);
                setSelectedPersonaName(undefined);
                setStep("confirm");
                return;
              }
              const persona = personas.find((candidate) => candidate.id === item.value);
              if (!persona) {
                return;
              }
              if (persona.sessionStatus === "ready") {
                const resolvedPath = resolvePersonaStorageStatePath(runtime, persona.id);
                setPersonaId(persona.id);
                setSelectedPersonaName(persona.name);
                setStorageStatePath(resolvedPath);
                setStep("confirm");
                return;
              }
              setSignInIntent({ mode: "reconnect", personaId: persona.id, name: persona.name });
              setStep("signingIn");
            }}
          />
        </>
      ) : null}
      {step === "personaName" ? (
        <>
          <Text>{signInIntent?.mode === "create" ? "Name this persona" : "Name this test-account persona"}</Text>
          <TextInput
            value={personaNameDraft}
            onChange={setPersonaNameDraft}
            onSubmit={(raw) => {
              const trimmed = raw.trim();
              if (trimmed.length === 0) {
                setError("Enter a name for this persona, or press Esc to cancel.");
                return;
              }
              setError(undefined);
              setPendingPersonaName(trimmed);
              setPersonaNameDraft("");
              if (signInIntent?.mode === "create") {
                setStep("signingIn");
              } else {
                setStep("personaReference");
              }
            }}
          />
        </>
      ) : null}
      {step === "personaReference" ? (
        <>
          <Text>Test-account reference (e.g. an account name your team recognizes)</Text>
          <TextInput
            value={personaReferenceDraft}
            onChange={setPersonaReferenceDraft}
            onSubmit={submitPersonaReference}
          />
        </>
      ) : null}
      {step === "signingIn" ? (
        <Box flexDirection="column">
          {loginStatus === "opening" ? (
            <Text color={palette.cyan}>Opening a browser at {targetUrl}…</Text>
          ) : null}
          {loginStatus === "waiting" ? (
            <>
              <Text color={palette.cyan}>Sign in in the browser window that just opened.</Text>
              <Text color={palette.muted}>[Enter] I&apos;m signed in — capture this session</Text>
            </>
          ) : null}
          {loginStatus === "saving" ? <Text color={palette.cyan}>Saving session…</Text> : null}
          {loginStatus === "error" ? (
            <>
              <Text color={palette.red}>Sign-in failed: {loginError}</Text>
              <Text color={palette.muted}>[Esc] Cancel and go back</Text>
            </>
          ) : null}
        </Box>
      ) : null}
      {step === "confirm" ? (
        <>
          <Text>
            Add to project <Text color={palette.cyan}>{projects.find((p) => p.id === projectId)?.name ?? projectId}</Text>: crawl{" "}
            <Text color={palette.cyan}>{targetUrl}</Text>
            {applicationName ? (
              <>
                {" "}
                as <Text color={palette.cyan}>{applicationName}</Text>
              </>
            ) : (
              <> — Nova will identify the application from the crawl</>
            )}{" "}
            ({environment})
            {selectedPersonaName ? (
              <>
                {" "}
                as persona <Text color={palette.cyan}>{selectedPersonaName}</Text>
              </>
            ) : authReason ? (
              <> — public areas only (no persona selected)</>
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
