import { RotaEntry, Settings } from "../model";
import { addDays, localAt, MINUTE, onDate } from "./time";

export interface BeforeShiftSleepPreferences {
  category: "Early" | "Late";
  shiftDate: string;
  preparationDate: string;
  bedtimeClock: string | null;
  wakeClock: string | null;
  bedtime: number | null;
  wake: number | null;
  missing: string[];
}

/** New preferences describe the night before this duty, not a rest-day routine.
 * Their clock times need their own DST review, independent of the duty time. */
export function beforeShiftSleepPreferences(
  entry: RotaEntry,
  settings: Settings,
  shiftStart: number,
): BeforeShiftSleepPreferences | null {
  if (entry.category !== "Early" && entry.category !== "Late") return null;
  const bedtimeClock =
      (entry.category === "Early"
        ? settings.beforeEarlyBed
        : settings.beforeLateBed) || null,
    wakeClock =
      (entry.category === "Early"
        ? settings.beforeEarlyWake
        : settings.beforeLateWake) || null;
  if (!bedtimeClock && !wakeClock) return null;
  const shiftDate = localAt(shiftStart, entry.timezone).slice(0, 10),
    preparationDate = addDays(shiftDate, -1),
    missing: string[] = [];
  const parse = (date: string, clock: string | null, label: string) => {
    if (!clock) return null;
    try {
      return onDate(date, clock, entry.timezone);
    } catch (error) {
      missing.push(
        `Review ${label} before an ${entry.category.toLowerCase()} shift on ${date}: ${error instanceof Error ? error.message : String(error)} Your preference has not been moved to a different clock time or calendar day.`,
      );
      return null;
    }
  };
  return {
    category: entry.category,
    shiftDate,
    preparationDate,
    bedtimeClock,
    wakeClock,
    bedtime: parse(preparationDate, bedtimeClock, "bedtime"),
    wake: parse(shiftDate, wakeClock, "wake time"),
    missing,
  };
}

/** Honour an earlier chosen bedtime. A later one is flagged while the full
 * sleep target and latency remain protected by the calculated earlier bedtime. */
export function beforeShiftBedtime(
  preference: BeforeShiftSleepPreferences,
  wake: number,
  targetMinutes: number,
  latencyMinutes: number,
) {
  const requiredBedtime = wake - (targetMinutes + latencyMinutes) * MINUTE,
    chosen = preference.bedtime,
    bedtime =
      chosen === null ? requiredBedtime : Math.min(chosen, requiredBedtime),
    opportunity =
      chosen === null
        ? null
        : Math.max(0, Math.floor((wake - chosen) / MINUTE - latencyMinutes));
  const conflicts: string[] = [];
  if (opportunity !== null && opportunity < targetMinutes)
    conflicts.push(
      `Your bedtime before a ${preference.category.toLowerCase()} shift (${preference.bedtimeClock}) offers only ${opportunity} minutes of estimated sleep after ${latencyMinutes} minutes latency. Your ${targetMinutes}-minute target needs the earlier calculated bedtime; the target has not been shortened and your entered preference is retained in Settings.`,
    );
  return {
    bedtime,
    sleepStart: bedtime + latencyMinutes * MINUTE,
    opportunity,
    conflicts,
  };
}
