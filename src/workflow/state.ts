import { Annotation } from "@langchain/langgraph";

import type { TestRunState } from "../domain/index.js";

/**
 * TestRunState is the durable domain object (validated by
 * TestRunStateSchema everywhere it's persisted); this wraps it as a
 * single LangGraph channel rather than exploding every field into its own
 * annotation. Each node reads `state.run`, does its work, and returns
 * `{ run: <updated TestRunState> }` — LangGraph's reducer here is a plain
 * overwrite, since nodes always hand back the complete, already-merged
 * object rather than a partial patch.
 */
export const GraphStateAnnotation = Annotation.Root({
  // LangGraph evaluates `default()` eagerly when constructing the channel,
  // not lazily on first missing access, so a throwing default breaks graph
  // construction itself. `run` is required at the domain-schema level
  // (TestRunStateSchema) and every real invocation always supplies one —
  // this cast exists solely to satisfy Annotation's channel-construction
  // requirement for a value that is never actually read.
  run: Annotation<TestRunState>({
    reducer: (_previous: TestRunState, next: TestRunState) => next,
    default: () => undefined as unknown as TestRunState,
  }),
});

export type GraphState = typeof GraphStateAnnotation.State;
