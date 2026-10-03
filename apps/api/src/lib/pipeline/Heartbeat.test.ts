import { describe, expect, test } from "bun:test";
import { AttemptFailure, CancelledError } from "./errors";
import { Heartbeat } from "./Heartbeat";

/** A heartbeat whose timer never fires on its own, so tests drive `check()` with explicit clocks. */
function manual(parent = new AbortController().signal, limitMs = 60_000): Heartbeat {
  return new Heartbeat(parent, { limitMs, checkEveryMs: 1_000_000 });
}

describe("Heartbeat", () => {
  test("stays quiet while beats keep arriving", () => {
    const heartbeat = manual();
    heartbeat.enter("downloading");
    heartbeat.check(Date.now() + 30_000);
    heartbeat.beat();
    heartbeat.check(Date.now() + 59_000);

    expect(heartbeat.stuckReason).toBeNull();
    expect(heartbeat.signal.aborted).toBe(false);
    heartbeat.dispose();
  });

  test("trips once the work has been silent past the limit, naming the step", async () => {
    const heartbeat = manual();
    heartbeat.enter("sterilizing");
    const guarded = heartbeat.guard(new Promise(() => {}));
    heartbeat.check(Date.now() + 61_000);

    expect(heartbeat.stuckReason).toBe("Stuck: nothing happened while sterilizing for 1 min");
    expect(heartbeat.signal.aborted).toBe(true);
    await expect(guarded).rejects.toBeInstanceOf(AttemptFailure);
    heartbeat.dispose();
  });

  test("a cancellation from above rejects guarded work and aborts the signal", async () => {
    const parent = new AbortController();
    const heartbeat = manual(parent.signal);
    const guarded = heartbeat.guard(new Promise(() => {}));
    parent.abort();

    await expect(guarded).rejects.toBeInstanceOf(CancelledError);
    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.stuckReason).toBeNull();
    heartbeat.dispose();
  });

  test("guarded work that settles passes its result through", async () => {
    const heartbeat = manual();
    expect(await heartbeat.guard(Promise.resolve(42))).toBe(42);
    heartbeat.dispose();
  });

  test("its own timer catches silence without anyone calling check", async () => {
    const heartbeat = new Heartbeat(new AbortController().signal, { limitMs: 40 });
    heartbeat.enter("saving");
    await expect(heartbeat.guard(new Promise(() => {}))).rejects.toThrow("Stuck: nothing happened while saving");
    heartbeat.dispose();
  });
});
