/**
 * Coalesce rapid alarm notifications without discarding an in-flight snapshot.
 *
 * Each read is numbered when it starts (`started` counts them). A `refresh()`
 * while a read is in flight always causes one more read to start afterwards, so
 * a caller can wait for a result whose read started after a given moment by
 * comparing the delivered sequence number with `started` taken at that moment.
 */
export class AlarmRefreshQueue<T> {
  private running = false;
  private dirty = false;
  private disposed = false;
  private startedReads = 0;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly received: (value: T, seq: number) => void,
    private readonly failed: (error: unknown, seq: number) => void,
  ) {}

  /** Number of reads started so far (the sequence number of the latest one). */
  get started(): number {
    return this.startedReads;
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    void this.run();
  }

  dispose(): void {
    this.disposed = true;
  }

  private async run(): Promise<void> {
    do {
      this.dirty = false;
      const seq = ++this.startedReads;
      try {
        const value = await this.read();
        if (!this.disposed) this.received(value, seq);
      } catch (error) {
        if (!this.disposed) this.failed(error, seq);
      }
    } while (this.dirty && !this.disposed);
    this.running = false;
  }
}
