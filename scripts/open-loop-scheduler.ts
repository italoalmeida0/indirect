/** Fixed arrival times never wait for earlier operations. At the in-flight
 * limit an arrival is counted as overloaded, rather than queued or delayed.
 * The returned counters include every offered slot and the final drain. */
export async function runOpenLoop(options: {
  durationMs: number;
  rate: number;
  maxInFlight: number;
  operation: (index: number, intendedAt: number) => Promise<unknown>;
  clock?: { now: () => number; sleep: (milliseconds: number) => Promise<void> };
}) {
  const { durationMs, rate, maxInFlight, operation } = options;
  const count = Math.ceil(durationMs * rate / 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(count) || count < 1) throw new Error("duration and rate must define a finite positive arrival count");
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new Error("maxInFlight must be a positive integer");
  const clock = options.clock ?? { now: () => performance.now(), sleep: (milliseconds: number) => Bun.sleep(milliseconds) };
  const began = clock.now();
  const pending = new Set<Promise<void>>();
  const errors: Array<{ index: number; message: string }> = [];
  let offered = 0, started = 0, completed = 0, overloaded = 0, failed = 0, peakInFlight = 0;
  let delayTotal = 0, delayMax = 0;
  const until = async (time: number) => {
    for (let remaining = time - clock.now(); remaining > 0; remaining = time - clock.now()) await clock.sleep(remaining);
  };
  for (let index = 0; index < count; index++) {
    const intendedAt = began + index * 1000 / rate;
    await until(intendedAt);
    offered++;
    if (pending.size >= maxInFlight) { overloaded++; continue; }
    started++;
    const delay = Math.max(0, clock.now() - intendedAt);
    delayTotal += delay; delayMax = Math.max(delayMax, delay);
    let result: Promise<unknown>;
    try { result = operation(index, intendedAt); }
    catch (error) { result = Promise.reject(error); }
    const task: Promise<void> = Promise.resolve(result).then(() => undefined, (error: unknown) => {
      failed++;
      if (errors.length < 20) errors.push({ index, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }).finally(() => { completed++; pending.delete(task); });
    pending.add(task);
    peakInFlight = Math.max(peakInFlight, pending.size);
  }
  // Keep the offering window's full duration, even when the last scheduled
  // arrival was earlier. Sampling may continue through the following drain.
  await until(began + durationMs);
  const offeringMs = clock.now() - began;
  const completedDuringOffering = completed, inFlightAtOfferEnd = pending.size;
  await Promise.all(pending);
  const totalMs = clock.now() - began;
  return {
    offered, started, completed, overloaded, failed, errors, maxInFlight, peakInFlight,
    completedDuringOffering, inFlightAtOfferEnd, plannedDurationMs: durationMs,
    offeringMs, drainMs: totalMs - offeringMs, totalMs,
    ratesPerSecond: {
      offered: offered * 1000 / offeringMs,
      started: started * 1000 / offeringMs,
      completedDuringOffering: completedDuringOffering * 1000 / offeringMs,
      completedIncludingDrain: completed * 1000 / totalMs,
    },
    schedulingDelayMs: { mean: started ? delayTotal / started : 0, max: delayMax },
  };
}
