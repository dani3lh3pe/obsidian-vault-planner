/**
 * One remote task source beside the vault — Planner, To Do (M9, spec no. 40). Two rules:
 *
 * - Only the newest read may land. A read still running when the source is switched off, or when
 *   a newer read started, changes nothing.
 * - A write marks its task until a read started AFTER the write shows a different etag: the source
 *   can lag behind its own writes, and a second click on a spent etag would only earn a 412. A
 *   failed write (spent null) is released by the next such read.
 */
export class RemoteSource<T extends { readonly tasks: readonly { readonly id: string; readonly etag: string | null }[] }> {
  snapshot: T | null = null;
  error: string | null = null;
  /** When the last read started: returning to the view reads again only after half a clock. */
  readAt = 0;
  private seq = 0;
  private inFlight: number | null = null;
  private readonly writing = new Map<string, { from: number; spent: string | null }>();

  /** Switched off or signed out. False when there was nothing to clear, so nothing to render. */
  clear(): boolean {
    this.seq += 1;
    if (this.snapshot === null && this.error === null) return false;
    this.snapshot = null;
    this.error = null;
    this.writing.clear();
    return true;
  }

  /**
   * `force` starts a read even while one runs — after a write only a read started now can show it;
   * the clocks wait, or a slow read would be superseded forever. False: skipped or superseded,
   * nothing to render.
   */
  async read(load: () => Promise<T>, describe: (error: unknown) => string, force: boolean): Promise<boolean> {
    if (!force && this.inFlight !== null) return false;
    const seq = ++this.seq;
    this.inFlight = seq;
    this.readAt = Date.now();
    try {
      const snapshot = await load();
      if (seq !== this.seq) return false;
      this.snapshot = snapshot;
      this.error = null;
      for (const [id, mark] of this.writing) {
        const now = snapshot.tasks.find((task) => task.id === id);
        if (seq >= mark.from && (mark.spent === null || now?.etag !== mark.spent)) this.writing.delete(id);
      }
      return true;
    } catch (error) {
      if (seq !== this.seq) return false;
      this.error = describe(error);
      return true;
    } finally {
      if (this.inFlight === seq) this.inFlight = null;
    }
  }

  /** The task as the LAST read knows it: its etag may have changed since the card was built. */
  task(id: string): T["tasks"][number] | undefined {
    return this.snapshot?.tasks.find((task) => task.id === id);
  }

  isWriting(id: string): boolean {
    return this.writing.has(id);
  }

  /** Before the write: "Saving…" until a read started after endWrite has come back. */
  beginWrite(id: string): void {
    this.writing.set(id, { from: Number.POSITIVE_INFINITY, spent: null });
  }

  /** After it: `spent` is the etag the write used, null when it failed. */
  endWrite(id: string, spent: string | null): void {
    this.writing.set(id, { from: this.seq + 1, spent });
  }
}
