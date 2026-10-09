import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repeatPasses } from "../src/shared/passes";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A pass that asks about `n` clips, each answer taking `askMs`. */
function slowPass(n: number, askMs: number) {
  const log = { started: 0, running: 0, mostAtOnce: 0, asked: 0 };
  const pass = async (stopped: () => boolean) => {
    log.started++;
    log.running++;
    log.mostAtOnce = Math.max(log.mostAtOnce, log.running);
    try {
      for (let i = 0; i < n; i++) {
        if (stopped()) return;
        await new Promise((r) => setTimeout(r, askMs));
        log.asked++;
      }
    } finally {
      log.running--;
    }
  };
  return { log, pass };
}

describe("repeatPasses", () => {
  it("never runs two passes at once when a pass outlasts the gap", async () => {
    // 400 clips at 1.7 s each: about 11 minutes a pass, against a 5 s gap.
    const { log, pass } = slowPass(400, 1700);
    const stop = repeatPasses(pass, 5000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    stop();
    expect(log.mostAtOnce).toBe(1);
    // Two full passes and part of a third, not one new pass every 5 s.
    expect(log.started).toBe(3);
    expect(log.asked).toBeLessThan(3 * 400);
  });

  it("waits the gap after a pass finishes before the next", async () => {
    const { log, pass } = slowPass(1, 100);
    const stop = repeatPasses(pass, 5000);
    await vi.advanceTimersByTimeAsync(100);
    expect(log.started).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(log.started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.started).toBe(2);
    stop();
  });

  it("stops the pass under way partway, and starts none after", async () => {
    const { log, pass } = slowPass(400, 1700);
    const stop = repeatPasses(pass, 5000);
    await vi.advanceTimersByTimeAsync(10 * 1700);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(log.started).toBe(1);
    // The ask in flight when it stopped still lands; nothing after it.
    expect(log.asked).toBe(11);
  });

  it("keeps going after a pass that throws", async () => {
    let calls = 0;
    const stop = repeatPasses(async () => {
      calls++;
      throw new Error("hiccup");
    }, 5000);
    await vi.advanceTimersByTimeAsync(10_001);
    stop();
    expect(calls).toBe(3);
  });
});
