import { systemClock, type Clock } from "../model";
import { MINUTE } from "./time";

export interface PlannerClockTimers {
  setTimeout(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const defaultTimers: PlannerClockTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Refresh display-only planning at whole minutes, including local 00:01.
 * Delayed/background timers refresh once from the current clock instead of
 * replaying missed minutes. Foreground callers use refresh() to catch up.
 */
export function startPlannerClock(
  onRefresh: () => void,
  clock: Clock = systemClock,
  timers: PlannerClockTimers = defaultTimers,
) {
  let active = true;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    ++generation;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  }

  function arm() {
    if (!active) return;
    const lifecycle = generation;
    const remainder = ((clock.now() % MINUTE) + MINUTE) % MINUTE;
    timer = timers.setTimeout(() => {
      if (!active || lifecycle !== generation) return;
      timer = undefined;
      refresh();
    }, MINUTE - remainder);
  }

  function refresh() {
    if (!active) return;
    cancel();
    try {
      onRefresh();
    } finally {
      arm();
    }
  }

  arm();
  return {
    refresh,
    stop() {
      active = false;
      cancel();
    },
  };
}
