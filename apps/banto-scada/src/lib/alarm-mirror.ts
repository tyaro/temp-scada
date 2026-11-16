/**
 * One condition as the host sends it (`scada_alarm::ConditionState`, design §4.1).
 * The display state is not sent; `alarm-view.ts` derives it with the same rule.
 */
export interface AlarmConditionState {
  readonly active: boolean;
  readonly occurrence: string | null;
  readonly recurrence: number;
  readonly acked: boolean;
  readonly timer: {
    readonly kind: "onDelay" | "offDelay";
    readonly dueMs: number;
  } | null;
  /** Condition-level reason it cannot be evaluated (initialValue, stale, bad, ...). */
  readonly unavailable: string | null;
  readonly reportedUnavailable: string | null;
  readonly orderKey: {
    readonly generation: number;
    readonly seq: number;
  } | null;
  readonly occurredAtMs: number | null;
  readonly observation: unknown;
}

/** Display information of an applied condition (`alarm_db::ConditionDisplay`). */
export interface AlarmConditionDisplay {
  readonly name: string;
  readonly message: string;
  readonly severity: string;
  readonly limitLabel: string | null;
}

/** The alarm host is authoritative. A missed event always requests a full snapshot. */
export interface AlarmSnapshot {
  readonly monitored: { readonly projectId: string } | null;
  readonly applied: {
    readonly projectId: string;
    readonly projectRevision: number;
    readonly appliedAtMs: number;
    /** Keyed by condition id. */
    readonly displays: Readonly<Record<string, AlarmConditionDisplay>>;
  } | null;
  readonly engine: {
    readonly session: { readonly id: string; readonly generation: number };
    readonly seq: number;
    /** Engine-level reason it cannot evaluate (disconnected, receiveLost). */
    readonly unavailable: string | null;
    readonly conditions: Readonly<Record<string, AlarmConditionState>>;
  } | null;
  readonly status: string;
  readonly pendingConditionChanges: boolean;
  readonly pendingDisplayChanges: boolean;
  /** The alarm DB cannot be written; ACK and apply are refused meanwhile. */
  readonly historyWriteFailure: {
    readonly sinceWallMs: number;
    readonly unrecordedEvents: number;
  } | null;
  /** Rereads of the current values keep failing; evaluation continues. */
  readonly rereadFailure: {
    readonly sinceWallMs: number;
    readonly failures: number;
  } | null;
}

export interface AlarmChange {
  readonly session: { readonly id: string; readonly generation: number };
  readonly seq: number;
  readonly conditions: Readonly<Record<string, AlarmConditionState | null>>;
  readonly engineUnavailable: string | null;
  readonly applied?: AlarmSnapshot["applied"];
}

export type ChangeDecision = "applied" | "ignored" | "refresh";

export class AlarmMirror {
  current: AlarmSnapshot | null = null;
  private stoppedGeneration: number | null = null;

  acceptSnapshot(next: AlarmSnapshot): boolean {
    const oldGeneration = this.current?.engine?.session.generation;
    const nextGeneration = next.engine?.session.generation;
    if (
      nextGeneration !== undefined &&
      this.stoppedGeneration !== null &&
      nextGeneration <= this.stoppedGeneration
    )
      return false;
    if (
      oldGeneration !== undefined &&
      nextGeneration !== undefined &&
      nextGeneration < oldGeneration
    )
      return false;
    if (
      oldGeneration === nextGeneration &&
      this.current?.engine &&
      next.engine &&
      next.engine.seq < this.current.engine.seq
    )
      return false;
    if (nextGeneration === undefined && oldGeneration !== undefined)
      this.stoppedGeneration = Math.max(
        this.stoppedGeneration ?? oldGeneration,
        oldGeneration,
      );
    if (nextGeneration !== undefined) this.stoppedGeneration = null;
    this.current = next;
    return true;
  }

  acceptChange(change: AlarmChange): ChangeDecision {
    const snapshot = this.current;
    const engine = snapshot?.engine;
    if (!snapshot || !engine) return "refresh";
    if (change.session.generation < engine.session.generation) return "ignored";
    if (
      change.session.generation > engine.session.generation ||
      change.session.id !== engine.session.id
    )
      return "refresh";
    if (change.seq <= engine.seq) return "ignored";
    if (change.seq !== engine.seq + 1) return "refresh";
    if (change.applied) return "refresh";
    const conditions: Record<string, AlarmConditionState> = {
      ...engine.conditions,
    };
    for (const [id, state] of Object.entries(change.conditions)) {
      if (state === null) delete conditions[id];
      else conditions[id] = state;
    }
    this.current = {
      ...snapshot,
      applied: change.applied ?? snapshot.applied,
      engine: {
        ...engine,
        seq: change.seq,
        unavailable: change.engineUnavailable,
        conditions,
      },
    };
    return "applied";
  }
}
