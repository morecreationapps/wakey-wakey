import { Temporal } from "@js-temporal/polyfill";
import type { RotaEntry } from "../model";
import { validDate } from "../data/rota";
import { addDays, calendarDaysBetween } from "../engine/time";
import { replacePickerDate } from "./pickerValues";

/** Move calendar dates together without flattening an overnight or actual finish. */
export function moveRotaEntryDate(entry: RotaEntry, date: string): RotaEntry {
  if (!validDate(date) || !validDate(entry.date))
    throw new RangeError("Choose a valid rota date.");
  if (date === entry.date) return entry;
  const move = (local: string | null): string | null => {
    if (local === null) return null;
    const originalDate = Temporal.PlainDateTime.from(local, {
      overflow: "reject",
    })
      .toPlainDate()
      .toString();
    return replacePickerDate(
      local,
      addDays(date, calendarDaysBetween(entry.date, originalDate)),
    );
  };
  return {
    ...entry,
    date,
    start: move(entry.start),
    end: move(entry.end),
    ...(entry.actualEnd === undefined
      ? {}
      : { actualEnd: move(entry.actualEnd) }),
  };
}

/** Explicit non-work entries contain no residual work boundaries or overtime. */
export function normaliseRotaEntry(entry: RotaEntry): RotaEntry {
  if (entry.status === "Work") return entry;
  return {
    ...entry,
    start: null,
    end: null,
    actualEnd: null,
    overtimeMinutes: 0,
    ...(entry.status === "Rest"
      ? { duty: "", breakMinutes: null, paidMinutes: null }
      : {}),
  };
}
