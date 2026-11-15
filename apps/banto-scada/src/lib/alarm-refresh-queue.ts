/** Coalesce rapid alarm notifications without discarding an in-flight snapshot. */
export class AlarmRefreshQueue<T> {
  private running = false;
  private dirty = false;
  private disposed = false;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly received: (value: T) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

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
      try {
        const value = await this.read();
        if (!this.disposed) this.received(value);
      } catch (error) {
        if (!this.disposed) this.failed(error);
      }
    } while (this.dirty && !this.disposed);
    this.running = false;
  }
}
