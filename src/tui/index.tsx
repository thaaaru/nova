import React from "react";
import { render } from "ink";

import type { NovaRuntime } from "../cli/context.js";
import { App } from "./app.js";

/** Mounts the Ink app against a real NovaRuntime and resolves once the operator quits. */
export async function runTui(runtime: NovaRuntime): Promise<void> {
  const instance = render(<App runtime={runtime} />);
  await instance.waitUntilExit();
}
