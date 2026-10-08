import { Temporal } from "@js-temporal/polyfill";
import { Clock, ISODate, Settings } from "../model";

/** Local duty times always use their recorded IANA zone, never the device zone. */
export function zonedEpoch(
  local: string,
  timezone: string,
  disambiguation?: "earlier" | "later",
): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local)) {
    throw new RangeError(
      "Use an unambiguous local date/time: YYYY-MM-DDTHH:mm.",
    );
  }
  const plain = Temporal.PlainDateTime.from(local, { overflow: "reject" });
  const zoned = plain.toZonedDateTime(timezone, {
    disambiguation: disambiguation ?? "reject",
  });
  // Earlier/later distinguishes repeated autumn times. It must not silently
  // move a nonexistent spring time to a different wall-clock time.
  if (!zoned.toPlainDateTime().equals(plain))
    throw new RangeError(
      "This local time does not exist in the recorded timezone; correct it.",
    );
  return zoned.epochMilliseconds;
}

export function localAt(epoch: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epoch)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

export function addDays(date: ISODate, days: number): ISODate {
  return Temporal.PlainDate.from(date, { overflow: "reject" })
    .add({ days })
    .toString();
}

export function calendarDaysBetween(from: ISODate, to: ISODate): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), {
    largestUnit: "day",
  }).days;
}

export function dateInZone(clock: Clock, timezone: string): ISODate {
  return Temporal.Instant.fromEpochMilliseconds(clock.now())
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

export function displayTime(
  epoch: number,
  timezone: string,
  clockFormat: "24" | "12" = "24",
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: clockFormat === "12",
  }).format(epoch);
}

export function isWrittenDateFormat(format: Settings["dateFormat"]): boolean {
  return format === "LONG" || format === "LONG_ISO";
}

export function displayDate(
  date: ISODate,
  format: Settings["dateFormat"] = "UK",
): string {
  const d = Temporal.PlainDate.from(date, { overflow: "reject" });
  if (format === "ISO") return d.toString();
  if (isWrittenDateFormat(format)) {
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    if (format === "LONG_ISO")
      return `${weekdays[d.dayOfWeek - 1]} ${d.year} ${months[d.month - 1]} ${d.day}`;
    const lastTwo = d.day % 100;
    const suffix =
      lastTwo >= 11 && lastTwo <= 13
        ? "th"
        : (["th", "st", "nd", "rd"][d.day % 10] ?? "th");
    return `${weekdays[d.dayOfWeek - 1]} ${d.day}${suffix} ${months[d.month - 1]} ${d.year}`;
  }
  return `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
}

/** Format recorded wall-clock timestamps without applying a device timezone. */
export function displayLocalDateTime(
  local: string,
  format: Settings["dateFormat"] = "UK",
): string {
  return isWrittenDateFormat(format)
    ? `${displayDate(local.slice(0, 10), format)} ${local.slice(11)}`
    : local.replace("T", " ");
}

export function onDate(
  date: ISODate,
  time: string,
  timezone: string,
  disambiguation?: "earlier" | "later",
): number {
  if (!/^\d{2}:\d{2}$/.test(time))
    throw new RangeError("Use HH:mm for a preferred local time.");
  // Constructing a local timestamp is separate from calendar/elapsed arithmetic.
  const p = Temporal.PlainDate.from(date).toPlainDateTime(
    Temporal.PlainTime.from(time, { overflow: "reject" }),
  );
  return zonedEpoch(
    p.toString({ smallestUnit: "minute" }),
    timezone,
    disambiguation,
  );
}

export const MINUTE = 60_000;
