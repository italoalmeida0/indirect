import { describe, expect, test } from "bun:test";
import { runOpenLoop } from "../scripts/open-loop-scheduler";

class Clock {
  time = 0;
  timers: Array<{ at: number; resolve: () => void }> = [];
  now = () => this.time;
  sleep = (milliseconds: number) => new Promise<void>((resolve) => this.timers.push({ at: this.time + milliseconds, resolve }));
  async flush() { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); }
  async advanceTo(time: number) {
    for (;;) {
      await this.flush();
      this.timers.sort((a, b) => a.at - b.at);
      if (!this.timers.length || this.timers[0]!.at > time) break;
      const timer = this.timers.shift()!;
      this.time = timer.at;
      timer.resolve();
    }
    this.time = time;
    await this.flush();
  }
}

describe("open-loop load scheduler", () => {
  test("slow work preserves every scheduled arrival and drains after offering ends", async () => {
    const clock = new Clock();
    const starts: Array<{ index: number; intendedAt: number; actualAt: number }> = [];
    let finished = false;
    const run = runOpenLoop({ durationMs: 4000, rate: 8, maxInFlight: 16, clock,
      operation: async (index, intendedAt) => { starts.push({ index, intendedAt, actualAt: clock.now() }); await clock.sleep(1500); },
    }).then((result) => { finished = true; return result; });
    await clock.advanceTo(4000);
    expect(starts).toHaveLength(32);
    expect(starts.map((entry) => entry.actualAt)).toEqual(Array.from({ length: 32 }, (_, index) => index * 125));
    expect(starts.every((entry) => entry.actualAt === entry.intendedAt)).toBe(true);
    expect(finished).toBe(false);
    await clock.advanceTo(5500);
    const result = await run;
    expect(result).toMatchObject({ offered: 32, started: 32, completed: 32, overloaded: 0, failed: 0, peakInFlight: 12, offeringMs: 4000, drainMs: 1375, totalMs: 5375, inFlightAtOfferEnd: 11 });
    expect(result.ratesPerSecond).toMatchObject({ offered: 8, started: 8, completedDuringOffering: 5.25 });
    expect(result.ratesPerSecond.completedIncludingDrain).toBeCloseTo(32 * 1000 / 5375);
  });

  test("the in-flight limit rejects arrivals explicitly without moving their schedule", async () => {
    const clock = new Clock(), starts: number[] = [];
    const run = runOpenLoop({ durationMs: 1000, rate: 8, maxInFlight: 2, clock,
      operation: async (_index, intendedAt) => { starts.push(intendedAt); await clock.sleep(1500); },
    });
    await clock.advanceTo(2000);
    const result = await run;
    expect(starts).toEqual([0, 125]);
    expect(result).toMatchObject({ offered: 8, started: 2, completed: 2, overloaded: 6, failed: 0, peakInFlight: 2, inFlightAtOfferEnd: 2, offeringMs: 1000, drainMs: 625 });
    expect(result.offered).toBe(result.started + result.overloaded);
    expect(result.started).toBe(result.completed);
    expect(result.ratesPerSecond).toMatchObject({ offered: 8, started: 2, completedDuringOffering: 0 });
  });

  test("synchronous and asynchronous operation failures are counted and release their slots", async () => {
    const clock = new Clock();
    const run = runOpenLoop({ durationMs: 1000, rate: 4, maxInFlight: 1, clock,
      operation: (index) => {
        if (index === 0) throw new Error("synchronous failure");
        return index === 1 ? Promise.reject(new Error("asynchronous failure")) : Promise.resolve();
      },
    });
    await clock.advanceTo(1000);
    expect(await run).toMatchObject({ offered: 4, started: 4, completed: 4, overloaded: 0, failed: 2,
      errors: [{ index: 0, message: "synchronous failure" }, { index: 1, message: "asynchronous failure" }],
      inFlightAtOfferEnd: 0, drainMs: 0 });
  });
});
