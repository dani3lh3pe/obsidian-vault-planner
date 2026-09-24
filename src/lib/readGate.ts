/**
 * Which calendar read may still change the screen, and when a "Wird gespeichert…" marker may go.
 *
 * The web app got these rules from React effects for free (stale responses discarded on cleanup);
 * vanilla code has to keep the books itself. Pure bookkeeping — the view owns network and timers.
 */
export class ReadGate {
  private latest = 0;
  private gestures = 0;
  private missed = false;
  /** Marker key (block id, or path+raw before the id exists) -> first read that may release it. */
  private readonly pending = new Map<string, number>();

  /** A new read begins; every older one becomes stale. */
  start(): number {
    this.latest += 1;
    return this.latest;
  }

  isCurrent(seq: number): boolean {
    return seq === this.latest;
  }

  /**
   * May the result of read `seq` be applied now? Not if a newer read started, and not during a
   * drag, resize or PATCH — then it is DROPPED (not held, it would be stale by then) and the view
   * reads again when the gesture ends.
   */
  accepts(seq: number): boolean {
    if (seq !== this.latest) return false;
    if (this.gestures > 0) {
      this.missed = true;
      return false;
    }
    return true;
  }

  /** A drag, resize or PATCH is under way: nothing may replace the calendar's events now. */
  get busy(): boolean {
    return this.gestures > 0;
  }

  beginGesture(): void {
    this.gestures += 1;
  }

  /** True when a result was dropped meanwhile and the view should read again. */
  endGesture(): boolean {
    this.gestures = Math.max(0, this.gestures - 1);
    if (this.gestures > 0 || !this.missed) return false;
    this.missed = false;
    return true;
  }

  /** The block id is written and the POST is about to run: the card must not be dragged again. */
  hold(blockId: string): void {
    this.pending.set(blockId, Number.POSITIVE_INFINITY);
  }

  /**
   * The POST is over (either way). Only a read that starts AFTER this moment can show the block,
   * so the marker waits for it — otherwise the card flips to "ungeplant" in between and invites a
   * second booking.
   */
  releaseAfterNextRead(blockId: string): void {
    this.pending.set(blockId, this.latest + 1);
  }

  /** Nothing was sent (the block id could not be written): the marker can go at once. */
  release(key: string): void {
    this.pending.delete(key);
  }

  /** Read `seq` was applied or failed. */
  settled(seq: number): void {
    for (const [blockId, from] of this.pending) {
      if (seq >= from) this.pending.delete(blockId);
    }
  }

  isPending(blockId: string): boolean {
    return this.pending.has(blockId);
  }
}
