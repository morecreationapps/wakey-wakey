import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  startOfWeek,
  weekdayLabels,
  weekdayOffset,
} from "../src/engine/calendar";
import type { Settings } from "../src/model";

describe("calendar first-day preference", () => {
  it.each<[Settings["firstDay"], string[]]>([
    ["Saturday", ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]],
    ["Monday", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]],
    ["Sunday", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]],
  ])("orders the weekday labels from %s", (preference, expected) => {
    expect(weekdayLabels(preference)).toEqual(expected);
  });

  it.each<[string, number]>([
    ["2026-10-03", 0],
    ["2026-10-04", 1],
    ["2026-10-05", 2],
    ["2026-10-06", 3],
    ["2026-10-07", 4],
    ["2026-10-08", 5],
    ["2026-10-09", 6],
  ])("keeps %s in the Saturday-to-Friday week", (date, expectedColumn) => {
    const day = Temporal.PlainDate.from(date);
    expect(startOfWeek(day, "Saturday").toString()).toBe("2026-10-03");
    expect(weekdayOffset(day, "Saturday")).toBe(expectedColumn);
  });

  it.each<[string, string, string]>([
    ["2027-01-01", "2026-12-26", "2027-01-01"],
    ["2024-01-01", "2023-12-30", "2024-01-05"],
    ["2024-02-29", "2024-02-24", "2024-03-01"],
    ["2024-03-01", "2024-02-24", "2024-03-01"],
    ["2024-03-02", "2024-03-02", "2024-03-08"],
    ["2026-03-30", "2026-03-28", "2026-04-03"],
  ])(
    "includes %s in the correct week across calendar boundaries",
    (date, expectedStart, expectedEnd) => {
      const day = Temporal.PlainDate.from(date);
      const first = startOfWeek(day, "Saturday");
      const dates = Array.from({ length: 7 }, (_, i) =>
        first.add({ days: i }).toString(),
      );
      expect(dates[0]).toBe(expectedStart);
      expect(dates[6]).toBe(expectedEnd);
      expect(dates).toContain(date);
      expect(day.toString()).toBe(date);
    },
  );

  it.each<[string, number, number, string, string]>([
    ["2026-10-01", 5, 31, "Thu", "Sat"],
    ["2027-01-01", 6, 31, "Fri", "Sun"],
    ["2024-02-01", 5, 29, "Thu", "Thu"],
    ["2024-03-01", 6, 31, "Fri", "Sun"],
    ["2025-02-01", 0, 28, "Sat", "Fri"],
  ])(
    "aligns month %s with Saturday-first headers without losing dates",
    (date, expectedPadding, expectedDays, firstLabel, lastLabel) => {
      const first = Temporal.PlainDate.from(date);
      const padding = weekdayOffset(first, "Saturday");
      const labels = weekdayLabels("Saturday");
      const grid = [
        ...Array.from({ length: padding }, () => null),
        ...Array.from({ length: first.daysInMonth }, (_, i) =>
          first.add({ days: i }).toString(),
        ),
      ];
      expect(padding).toBe(expectedPadding);
      expect(grid.filter((day) => day !== null)).toHaveLength(expectedDays);
      expect(grid[padding]).toBe(date);
      expect(grid.at(-1)).toBe(first.with({ day: expectedDays }).toString());
      expect(labels[padding]).toBe(firstLabel);
      expect(labels[(grid.length - 1) % 7]).toBe(lastLabel);
    },
  );

  it.each<[Settings["firstDay"], string, string, number]>([
    ["Monday", "2027-01-01", "2026-12-28", 4],
    ["Sunday", "2027-01-01", "2026-12-27", 5],
    ["Monday", "2024-03-03", "2024-02-26", 6],
    ["Sunday", "2024-03-03", "2024-03-03", 0],
    ["Monday", "2024-02-01", "2024-01-29", 3],
    ["Sunday", "2024-02-01", "2024-01-28", 4],
  ])(
    "preserves %s-first week and month placement for %s",
    (preference, date, expectedStart, expectedColumn) => {
      const day = Temporal.PlainDate.from(date);
      expect(startOfWeek(day, preference).toString()).toBe(expectedStart);
      expect(weekdayOffset(day, preference)).toBe(expectedColumn);
    },
  );
});
