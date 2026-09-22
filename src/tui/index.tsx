import React from "react";
import { render } from "ink";

import type { NovaRuntime } from "../cli/context.js";
import { App } from "./app.js";
import { shouldShowBanner } from "./components/Banner.js";

export type RunTuiOptions = {
  /** Corresponds to the `--no-banner` CLI flag. */
  noBanner?: boolean;
  /** Corresponds to `nova test <url>`: starts the guided flow against that target immediately. */
  target?: string;
  /** Corresponds to `nova test` with no URL: opens the guided flow, which resumes or asks for the target. */
  guided?: boolean;
};

/** Mounts the Ink app against a real NovaRuntime and resolves once the operator quits. */
export async function runTui(runtime: NovaRuntime, options: RunTuiOptions = {}): Promise<void> {
  const gate = {
    isTTY: Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY),
    noBanner: options.noBanner,
    ci: Boolean(process.env.CI),
  };
  const showBanner = shouldShowBanner(gate);
  if (!showBanner && process.env.NOVA_DEBUG_BANNER) {
    process.stderr.write(
      `[nova] startup banner suppressed: stdoutTTY=${process.stdout.isTTY} stdinTTY=${process.stdin.isTTY} noBanner=${gate.noBanner} CI=${gate.ci}\n`,
    );
  }
  const instance = render(
    <App
      runtime={runtime}
      showBanner={showBanner}
      initialTarget={options.target}
      startInGuidedFlow={options.guided}
    />,
  );
  await instance.waitUntilExit();
}
