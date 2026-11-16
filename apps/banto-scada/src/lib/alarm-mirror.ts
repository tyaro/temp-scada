/** The alarm host is authoritative. A missed event always requests a full snapshot. */
export interface AlarmSnapshot {
  readonly monitored: { readonly projectId: string } | null;
  readonly applied: {
    readonly projectId: string;
    readonly projectRevision: number;
    readonly appliedAtMs: number;
  } | null;
  readonly engine: {
    readonly session: { readonly id: string; readonly generation: number };
    readonly seq: number;
    readonly unavailable: string | null;
    readonly conditions: Readonly<Record<string, unknown>>;
  } | null;
  readonly status: string;
  readonly pendingConditionChanges: boolean;
  readonly pendingDisplayChanges: boolean;
  /** The alarm DB cannot be written; ACK and apply are refused meanwhile. */
  readonly historyWriteFailure: {
    readonly sinceWallMs: number;
    readonly unrecordedEvents: number;
  } | null;
}

export interface AlarmChange {
  readonly session: { readonly id: string; readonly generation: number };
  readonly seq: number;
  readonly conditions: Readonly<Record<string, unknown | null>>;
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
    const conditions: Record<string, unknown> = { ...engine.conditions };
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
