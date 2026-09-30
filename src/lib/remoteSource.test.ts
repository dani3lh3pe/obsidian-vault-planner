import { describe, expect, it } from "vitest";
import { RemoteSource } from "./remoteSource";

type Snapshot = { tasks: { id: string; etag: string | null }[] };
const snap = (etag: string | null): Snapshot => ({ tasks: [{ id: "t", etag }] });
const describeError = () => "kaputt";

/** A read that resolves when the test says so. */
function deferred(): { load: () => Promise<Snapshot>; resolve: (value: Snapshot) => void } {
  let resolve: (value: Snapshot) => void = () => undefined;
  const promise = new Promise<Snapshot>((done) => {
    resolve = done;
  });
  return { load: () => promise, resolve };
}

describe("RemoteSource", () => {
  it("lets only the newest read land, and skips a poll while one runs", async () => {
    const source = new RemoteSource<Snapshot>();
    const slow = deferred();
    const first = source.read(slow.load, describeError, false);
    expect(await source.read(async () => snap("b"), describeError, false)).toBe(false); // skipped: one runs
    expect(await source.read(async () => snap("new"), describeError, true)).toBe(true); // forced
    slow.resolve(snap("old"));
    expect(await first).toBe(false);
    expect(source.snapshot?.tasks[0].etag).toBe("new");
  });

  it("keeps a read that was running at clear() from bringing the tasks back", async () => {
    const source = new RemoteSource<Snapshot>();
    await source.read(async () => snap("a"), describeError, false);
    const slow = deferred();
    const running = source.read(slow.load, describeError, false);
    expect(source.clear()).toBe(true);
    slow.resolve(snap("b"));
    expect(await running).toBe(false);
    expect(source.snapshot).toBeNull();
    expect(source.clear()).toBe(false);
  });

  it("holds a write's mark until a LATER read shows a different etag", async () => {
    const source = new RemoteSource<Snapshot>();
    await source.read(async () => snap("e1"), describeError, false);
    source.beginWrite("t");
    source.endWrite("t", "e1");
    expect(source.isWriting("t")).toBe(true);
    await source.read(async () => snap("e1"), describeError, true); // lagging: still the spent etag
    expect(source.isWriting("t")).toBe(true);
    await source.read(async () => snap("e2"), describeError, true);
    expect(source.isWriting("t")).toBe(false);
  });

  it("releases a failed write with the next read, and a task that is gone", async () => {
    const source = new RemoteSource<Snapshot>();
    source.beginWrite("t");
    source.endWrite("t", null);
    await source.read(async () => snap("e1"), describeError, true);
    expect(source.isWriting("t")).toBe(false);

    source.beginWrite("t");
    source.endWrite("t", "e1");
    await source.read(async () => ({ tasks: [] }), describeError, true); // completed and filtered out
    expect(source.isWriting("t")).toBe(false);
  });

  it("keeps the last snapshot and reports the error when a read fails", async () => {
    const source = new RemoteSource<Snapshot>();
    await source.read(async () => snap("a"), describeError, false);
    expect(await source.read(async () => Promise.reject(new Error("x")), describeError, false)).toBe(true);
    expect(source.error).toBe("kaputt");
    expect(source.snapshot?.tasks[0].etag).toBe("a");
  });
});
