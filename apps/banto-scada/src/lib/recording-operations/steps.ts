/**
 * The numbered steps of the recording operations dialog (UX review
 * 2026-11-11 P1-7): 1 inspect, 2 pause and join, 3 apply, 4 resume (in the
 * recording management dialog). Only the next step's button is primary.
 */
export type OperationStep = 1 | 2 | 3 | 4;

export interface OperationStepInput {
  readonly canPreflight: boolean;
  readonly canPause: boolean;
  readonly canApply: boolean;
  /**
   * How far the last confirmed result went: 1 inspected, 2 paused and
   * joined, 3 applied (or an earlier applied request replayed), else 0.
   */
  readonly progress: 0 | 1 | 2 | 3;
}

/** The next step, or undefined while nothing can be pressed (waiting). */
export function nextOperationStep(
  input: OperationStepInput,
): OperationStep | undefined {
  // After an apply the run stays stopped: resuming comes first, even though a
  // new change could be inspected.
  if (input.progress === 3) return 4;
  if (input.canApply) return 3;
  if (input.canPause) return 2;
  if (input.canPreflight) return 1;
  return undefined;
}

/** Whether a step is behind the current progress. */
export function operationStepDone(
  step: OperationStep,
  input: OperationStepInput,
): boolean {
  const next = nextOperationStep(input);
  return next === undefined ? step <= input.progress : step < next;
}

/** The progress of a result outcome kind (async and sync results alike). */
export function outcomeProgress(
  kind: string | undefined,
): OperationStepInput["progress"] {
  switch (kind) {
    case "candidate":
      return 1;
    case "paused":
      return 2;
    case "applied":
    case "replay":
      return 3;
    default:
      return 0;
  }
}
