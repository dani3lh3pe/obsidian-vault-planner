import { describe, expect, it } from "vitest";
import { ReadGate } from "./readGate";

describe("ReadGate", () => {
  it("discards a response once a newer read has started", () => {
    const gate = new ReadGate();
    const poll = gate.start();
    const afterWrite = gate.start();
    expect(gate.accepts(poll)).toBe(false);
    expect(gate.accepts(afterWrite)).toBe(true);
  });

  it("drops a response that lands during a gesture and asks for a new read afterwards", () => {
    const gate = new ReadGate();
    const read = gate.start();
    gate.beginGesture();
    expect(gate.accepts(read)).toBe(false);
    expect(gate.endGesture()).toBe(true);
    expect(gate.endGesture()).toBe(false);
  });

  it("waits for every overlapping gesture to end", () => {
    const gate = new ReadGate();
    const read = gate.start();
    gate.beginGesture();
    gate.beginGesture();
    gate.accepts(read);
    expect(gate.endGesture()).toBe(false);
    expect(gate.endGesture()).toBe(true);
  });

  it("releases the saving marker only after a read that started after the POST", () => {
    // Scenario A of the review: a poll in flight when the POST returns must not release it.
    const gate = new ReadGate();
    gate.hold("t-1");
    const pollDuringPost = gate.start();
    gate.releaseAfterNextRead("t-1");
    gate.settled(pollDuringPost);
    expect(gate.isPending("t-1")).toBe(true);

    const afterPost = gate.start();
    gate.settled(afterPost);
    expect(gate.isPending("t-1")).toBe(false);
  });

  it("keeps the marker while the POST is still running", () => {
    const gate = new ReadGate();
    gate.hold("t-1");
    gate.settled(gate.start());
    expect(gate.isPending("t-1")).toBe(true);
  });

  it("releases a marker at once when nothing was sent", () => {
    const gate = new ReadGate();
    gate.hold("path\n- [ ] raw");
    gate.release("path\n- [ ] raw");
    expect(gate.isPending("path\n- [ ] raw")).toBe(false);
  });
});
