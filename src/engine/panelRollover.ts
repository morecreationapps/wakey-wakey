import { Temporal } from "@js-temporal/polyfill";
import { Clock, RotaEntry, Settings } from "../model";
import { addDays, dateInZone, localAt, zonedEpoch } from "./time";

export interface PanelRollover {
  /** Both panels advance together at 00:01 in the user's recorded timezone. */
  date: string;
  shiftPlanShift?: RotaEntry;
  transitionShift?: RotaEntry;
  nextRolloverAt: number;
}

/** A display boundary, unlike a recorded duty, may use compatible resolution:
 * a timezone that skips midnight advances the nonexistent 00:01 by that gap.
 * Repeated midnight uses its first occurrence. Recorded work still uses strict
 * zonedEpoch validation and is never silently moved to another wall-clock time.
 */
function rolloverBoundary(date: string, timezone: string): number {
  return Temporal.PlainDate.from(date, { overflow: "reject" })
    .toPlainDateTime("00:01")
    .toZonedDateTime(timezone, { disambiguation: "compatible" })
    .epochMilliseconds;
}

/** Retain yesterday's calendar reference until today's 00:01 boundary. */
export function panelCalendarDate(clock: Clock, timezone: string): string {
  const now = clock.now(),
    date = dateInZone({ now: () => now }, timezone);
  return now < rolloverBoundary(date, timezone) ? addDays(date, -1) : date;
}

interface RecordedWork {
  entry: RotaEntry;
  date: string;
  start: number | null;
}

function recordedWork(entry: RotaEntry): RecordedWork | undefined {
  if (entry.status !== "Work") return undefined;
  try {
    const start = entry.start
      ? zonedEpoch(entry.start, entry.timezone, entry.disambiguation)
      : null;
    return {
      entry,
      date:
        start === null
          ? Temporal.PlainDate.from(entry.date).toString()
          : localAt(start, entry.timezone).slice(0, 10),
      start,
    };
  } catch {
    try {
      // An invalid time remains selected for review instead of silently skipping
      // a recorded duty and replacing it with a later, apparently valid plan.
      return {
        entry,
        date: Temporal.PlainDate.from(entry.date, {
          overflow: "reject",
        }).toString(),
        start: null,
      };
    } catch {
      return undefined;
    }
  }
}

/** Select independent references without changing rota, tasks or calculations.
 * Shift Plan retains the current calendar day's first duty after it starts and
 * finishes. On a day without work it previews the next recorded duty.
 * Shift Transition prepares for the next block, rather than reusing yesterday's
 * preparation or advancing through every day of the current block. A new block
 * starts after a calendar gap or a change of category/timezone. A gap does not
 * assert that its unrecorded or unknown days are confirmed rest days: the normal
 * planner retains their missing-input/conflict checks.
 */
export function panelRollover(
  entries: RotaEntry[],
  settings: Pick<Settings, "timezone">,
  clock: Clock,
): PanelRollover {
  const now = clock.now(),
    snapshotClock = { now: () => now },
    date = panelCalendarDate(snapshotClock, settings.timezone),
    actualDate = dateInZone(snapshotClock, settings.timezone),
    boundary = rolloverBoundary(actualDate, settings.timezone),
    nextRolloverAt =
      now < boundary
        ? boundary
        : rolloverBoundary(addDays(actualDate, 1), settings.timezone);
  const work = entries
    .map(recordedWork)
    .filter((item): item is RecordedWork => !!item)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.start ?? Infinity) - (b.start ?? Infinity) ||
        a.entry.id.localeCompare(b.entry.id),
    );
  const shiftPlanShift = work.find((item) => item.date >= date)?.entry;
  const transitionShift = work.find((item, index) => {
    if (addDays(item.date, -1) < date) return false;
    const previous = work[index - 1];
    return (
      !previous ||
      item.date > addDays(previous.date, 1) ||
      item.entry.category !== previous.entry.category ||
      item.entry.timezone !== previous.entry.timezone
    );
  })?.entry;
  return { date, shiftPlanShift, transitionShift, nextRolloverAt };
}
