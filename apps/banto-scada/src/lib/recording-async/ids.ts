/** Fixed-size counters/credits, no used-ID set or retry queue. */
export const ID_ROLES = [
  "mutationAdmission",
  "readAdmission",
  "inspection",
  "callerOperation",
  "reconciliation",
  "lease",
  "cancel",
] as const;
export type IdRole = (typeof ID_ROLES)[number];
export function createIdPools(prefix: string) {
  const counters = Object.fromEntries(
    ID_ROLES.map((r) => [r, { used: 0, reserved: 0 }]),
  ) as Record<IdRole, { used: number; reserved: number }>;
  const tags: Record<IdRole, string> = {
    mutationAdmission: "ma",
    readAdmission: "ra",
    inspection: "in",
    callerOperation: "op",
    reconciliation: "re",
    lease: "ls",
    cancel: "cn",
  };
  return {
    reserve(credits: Partial<Record<IdRole, number>>): boolean {
      if (
        ID_ROLES.some(
          (r) =>
            counters[r].used + counters[r].reserved + (credits[r] ?? 0) > 4096,
        )
      )
        return false;
      ID_ROLES.forEach((r) => (counters[r].reserved += credits[r] ?? 0));
      return true;
    },
    take(role: IdRole): string {
      const c = counters[role];
      if (c.reserved < 1 || c.used >= 4096) throw Error("ID capacity");
      c.reserved--;
      return `${tags[role]}:${prefix}:${++c.used}`;
    },
    release(credits: Partial<Record<IdRole, number>>) {
      ID_ROLES.forEach((r) => {
        const n = credits[r] ?? 0;
        if (n < 0 || n > counters[r].reserved) throw Error("ID reservation");
        counters[r].reserved -= n;
      });
    },
    current() {
      return Object.freeze(
        Object.fromEntries(
          ID_ROLES.map((r) => [r, Object.freeze({ ...counters[r] })]),
        ) as Readonly<
          Record<IdRole, Readonly<{ used: number; reserved: number }>>
        >,
      );
    },
  };
}
