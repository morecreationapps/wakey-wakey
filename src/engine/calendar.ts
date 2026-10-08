import { Temporal } from "@js-temporal/polyfill";
import type { Settings } from "../model";

const firstWeekday: Record<Settings["firstDay"], number> = {
  Monday: 1,
  Saturday: 6,
  Sunday: 7,
};
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Column offset within the user's calendar week, using ISO weekday numbers. */
export function weekdayOffset(
  date: Temporal.PlainDate,
  firstDay: Settings["firstDay"],
): number {
  return (date.dayOfWeek - firstWeekday[firstDay] + 7) % 7;
}

export function startOfWeek(
  date: Temporal.PlainDate,
  firstDay: Settings["firstDay"],
): Temporal.PlainDate {
  return date.subtract({ days: weekdayOffset(date, firstDay) });
}

export function weekdayLabels(firstDay: Settings["firstDay"]): string[] {
  const start = firstWeekday[firstDay] - 1;
  return [...weekdays.slice(start), ...weekdays.slice(0, start)];
}
