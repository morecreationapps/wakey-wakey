import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startPlannerClock,
  type PlannerClockTimers,
} from "../src/engine/plannerClock";
import { localAt, MINUTE, zonedEpoch } from "../src/engine/time";

const zone = "Europe/London";
const setLocalTime = (local: string) =>
  vi.setSystemTime(zonedEpoch(local, zone));

describe("planner display clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocalTime("2026-10-10T23:59:17");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refreshes at midnight and precisely 00:01 regardless of mount time", () => {
    const seen: string[] = [];
    const controller = startPlannerClock(() =>
      seen.push(localAt(Date.now(), zone)),
    );
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(42_999);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["2026-10-11T00:00"]);
    vi.advanceTimersByTime(MINUTE - 1);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["2026-10-11T00:00", "2026-10-11T00:01"]);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });

  it("waits until the following minute when started exactly on a minute", () => {
    setLocalTime("2026-10-11T00:00");
    const refresh = vi.fn();
    const controller = startPlannerClock(refresh);
    vi.advanceTimersByTime(MINUTE - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    controller.stop();
  });

  it("refreshes immediately after background resume and aligns the next timer", () => {
    const seen: string[] = [];
    const controller = startPlannerClock(() =>
      seen.push(localAt(Date.now(), zone)),
    );
    setLocalTime("2026-10-12T07:43:22");
    controller.refresh();
    expect(seen).toEqual(["2026-10-12T07:43"]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(37_999);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["2026-10-12T07:43", "2026-10-12T07:44"]);
    controller.stop();
  });

  it("catches up once when a queued timer fires after a day instead of replaying minutes", () => {
    let now = zonedEpoch("2026-10-10T23:59:17", zone);
    const delays: number[] = [];
    const timers: PlannerClockTimers = {
      setTimeout(callback, delay) {
        delays.push(delay);
        return setTimeout(callback, delay);
      },
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const refresh = vi.fn();
    const controller = startPlannerClock(refresh, { now: () => now }, timers);
    now = zonedEpoch("2026-10-12T09:08:44", zone);
    vi.advanceTimersByTime(43_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(delays).toEqual([43_000, 16_000]);
    controller.stop();
  });

  it("cancels cleanup and ignores refreshes or already queued callbacks after stop", () => {
    const callbacks: (() => void)[] = [];
    const timers: PlannerClockTimers = {
      setTimeout(callback, delay) {
        callbacks.push(callback);
        return setTimeout(callback, delay);
      },
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const refresh = vi.fn();
    const controller = startPlannerClock(refresh, undefined, timers);
    controller.stop();
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    callbacks[0]();
    controller.refresh();
    vi.advanceTimersByTime(2 * MINUTE);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates a stale queued timer when foreground refresh replaces it", () => {
    const callbacks: (() => void)[] = [];
    const timers: PlannerClockTimers = {
      setTimeout(callback, delay) {
        callbacks.push(callback);
        return setTimeout(callback, delay);
      },
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const refresh = vi.fn();
    const controller = startPlannerClock(refresh, undefined, timers);
    controller.refresh();
    callbacks[0]();
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });

  it.each(["2026-03-29T00:59:17", "2026-10-25T00:59:17"])(
    "continues at whole minutes across the London daylight-saving boundary from %s",
    (local) => {
      setLocalTime(local);
      const seen: number[] = [];
      const controller = startPlannerClock(() => seen.push(Date.now()));
      vi.advanceTimersByTime(43_000);
      vi.advanceTimersByTime(MINUTE);
      expect(seen).toHaveLength(2);
      expect(seen.every((at) => at % MINUTE === 0)).toBe(true);
      expect(seen[1] - seen[0]).toBe(MINUTE);
      controller.stop();
    },
  );
});
