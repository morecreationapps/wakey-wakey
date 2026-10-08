import { Temporal } from "@js-temporal/polyfill";
import { displayDate } from "../engine/time";
import type { ISODate, LocalDateTime, Settings } from "../model";

export type ClockPeriod = "am" | "pm";
export interface ClockParts {
  hour: number;
  minute: number;
  period: ClockPeriod;
}

function clockFormat(format: Settings["clockFormat"]) {
  if (format !== "24" && format !== "12")
    throw new RangeError("Choose a 24-hour or 12-hour clock.");
}

function plainDate(value: ISODate): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new RangeError("Use YYYY-MM-DD for a picker date.");
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

function plainTime(value: string): Temporal.PlainTime {
  if (!/^\d{2}:\d{2}$/.test(value))
    throw new RangeError("Use HH:mm for a picker time.");
  return Temporal.PlainTime.from(value, { overflow: "reject" });
}

function plainDateTime(value: LocalDateTime): Temporal.PlainDateTime {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new RangeError(
      "Use YYYY-MM-DDTHH:mm[:ss] for a picker date and time.",
    );
  const parsed = Temporal.PlainDateTime.from(value, { overflow: "reject" });
  if (
    parsed.toString({
      smallestUnit: value.length === 19 ? "second" : "minute",
    }) !== value
  )
    throw new RangeError("Use a canonical picker date and time.");
  return parsed;
}

/** A wall-clock value has no device timezone or corresponding instant. */
export function formatPickerTime(
  value: string,
  format: Settings["clockFormat"] = "24",
): string {
  clockFormat(format);
  return plainTime(value).toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: format === "12",
  });
}

export function formatPickerDateTime(
  value: LocalDateTime,
  dateFormat: Settings["dateFormat"] = "UK",
  format: Settings["clockFormat"] = "24",
): string {
  if (!["UK", "ISO", "LONG", "LONG_ISO"].includes(dateFormat))
    throw new RangeError("Choose a supported picker date format.");
  const local = plainDateTime(value);
  return `${displayDate(local.toPlainDate().toString(), dateFormat)} ${formatPickerTime(
    local.toPlainTime().toString({ smallestUnit: "minute" }),
    format,
  )}`;
}

/** Month-only cells, padded with nulls to complete the chosen calendar weeks. */
export function calendarMonthDays(
  anchor: ISODate,
  firstDay: Settings["firstDay"],
): (ISODate | null)[] {
  const month = plainDate(anchor).with({ day: 1 });
  const weekStarts = { Monday: 1, Sunday: 7, Saturday: 6 };
  if (!Object.hasOwn(weekStarts, firstDay))
    throw new RangeError("Choose Monday, Sunday or Saturday as the first day.");
  const firstWeekday = weekStarts[firstDay];
  const leading = (month.dayOfWeek - firstWeekday + 7) % 7;
  const cells = Math.ceil((leading + month.daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => {
    const day = index - leading + 1;
    return day < 1 || day > month.daysInMonth
      ? null
      : month.with({ day }).toString();
  });
}

export function shiftCalendarMonth(anchor: ISODate, months: number): ISODate {
  if (!Number.isInteger(months))
    throw new RangeError("Move the calendar by a whole number of months.");
  const shifted = plainDate(anchor).with({ day: 1 }).add({ months }).toString();
  return plainDate(shifted).toString();
}

export function replacePickerDate(
  local: LocalDateTime,
  nextDate: ISODate,
): LocalDateTime {
  const time = plainDateTime(local).toPlainTime();
  return plainDate(nextDate)
    .toPlainDateTime(time)
    .toString({ smallestUnit: local.length === 19 ? "second" : "minute" });
}

export function replacePickerTime(
  local: LocalDateTime,
  nextTime: string,
): LocalDateTime {
  const date = plainDateTime(local).toPlainDate();
  return date
    .toPlainDateTime(plainTime(nextTime))
    .toString({ smallestUnit: "minute" });
}

export function toClockParts(
  value: string,
  format: Settings["clockFormat"],
): ClockParts {
  clockFormat(format);
  const time = plainTime(value);
  return {
    hour: format === "12" ? time.hour % 12 || 12 : time.hour,
    minute: time.minute,
    period: time.hour < 12 ? "am" : "pm",
  };
}

export function fromClockParts(
  hour: number,
  minute: number,
  format: Settings["clockFormat"],
  period: ClockPeriod = "am",
): string {
  clockFormat(format);
  if (
    !Number.isInteger(hour) ||
    hour < (format === "12" ? 1 : 0) ||
    hour > (format === "12" ? 12 : 23)
  )
    throw new RangeError("Choose an hour valid for the selected clock.");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59)
    throw new RangeError("Choose a minute between 0 and 59.");
  if (period !== "am" && period !== "pm")
    throw new RangeError("Choose am or pm.");
  const canonicalHour =
    format === "12" ? (hour % 12) + (period === "pm" ? 12 : 0) : hour;
  return Temporal.PlainTime.from(
    { hour: canonicalHour, minute },
    { overflow: "reject" },
  ).toString({ smallestUnit: "minute" });
}
