import { describe, expect, it } from "vitest";
import type { Settings } from "../src/model";
import {
  calendarMonthDays,
  formatPickerDateTime,
  formatPickerTime,
  fromClockParts,
  replacePickerDate,
  replacePickerTime,
  shiftCalendarMonth,
  toClockParts,
} from "../src/ui/pickerValues";

describe("picker wall-clock values", () => {
  it.each([
    ["00:00", "00:00", "12:00 am", 12, "am"],
    ["00:59", "00:59", "12:59 am", 12, "am"],
    ["01:05", "01:05", "01:05 am", 1, "am"],
    ["11:59", "11:59", "11:59 am", 11, "am"],
    ["12:00", "12:00", "12:00 pm", 12, "pm"],
    ["12:59", "12:59", "12:59 pm", 12, "pm"],
    ["14:08", "14:08", "02:08 pm", 2, "pm"],
    ["23:59", "23:59", "11:59 pm", 11, "pm"],
  ] as const)(
    "formats and round-trips %s in both clocks",
    (value, full, half, hour, period) => {
      expect(formatPickerTime(value, "24")).toBe(full);
      expect(formatPickerTime(value, "12")).toBe(half);
      const twelve = toClockParts(value, "12");
      expect(twelve).toEqual({ hour, minute: Number(value.slice(3)), period });
      expect(
        fromClockParts(twelve.hour, twelve.minute, "12", twelve.period),
      ).toBe(value);
      const twentyFour = toClockParts(value, "24");
      expect(twentyFour.hour).toBe(Number(value.slice(0, 2)));
      expect(
        fromClockParts(
          twentyFour.hour,
          twentyFour.minute,
          "24",
          twentyFour.period,
        ),
      ).toBe(value);
    },
  );
  it.each(["24", "12"] as const)(
    "round-trips every minute in the %s-hour clock",
    (format) => {
      for (let minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay++) {
        const value = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
        const parts = toClockParts(value, format);
        expect(
          fromClockParts(parts.hour, parts.minute, format, parts.period),
        ).toBe(value);
      }
    },
  );
  it.each([
    "",
    "1:05",
    "01:5",
    "24:00",
    "23:60",
    "-1:00",
    "12:00:30",
    "12:00Z",
    "12:00+01:00",
  ])("rejects noncanonical time %s", (value) => {
    expect(() => formatPickerTime(value)).toThrow(RangeError);
    expect(() => toClockParts(value, "12")).toThrow(RangeError);
  });
  it.each([
    [0, 0, "12"],
    [13, 0, "12"],
    [-1, 0, "24"],
    [24, 0, "24"],
    [1.5, 0, "24"],
    [12, -1, "12"],
    [12, 60, "12"],
    [12, 2.5, "24"],
    [NaN, 0, "24"],
    [12, Infinity, "12"],
  ] as const)(
    "rejects invalid clock parts %s:%s (%s)",
    (hour, minute, format) => {
      expect(() => fromClockParts(hour, minute, format)).toThrow(RangeError);
    },
  );
  it("does not silently accept an unsupported clock or period", () => {
    expect(() => formatPickerTime("12:00", "16" as "24")).toThrow(RangeError);
    expect(() => fromClockParts(12, 0, "12", "night" as "am")).toThrow(
      RangeError,
    );
  });
});

describe("picker date/time display and replacement", () => {
  const dates: [Settings["dateFormat"], string][] = [
    ["UK", "10/10/2026"],
    ["ISO", "2026-10-10"],
    ["LONG", "Sat 10th October 2026"],
    ["LONG_ISO", "Sat 2026 October 10"],
  ];
  it.each(
    dates.flatMap(
      ([dateFormat, date]) =>
        [
          [dateFormat, "24", `${date} 14:08`],
          [dateFormat, "12", `${date} 02:08 pm`],
        ] as const,
    ),
  )(
    "formats %s dates and a %s-hour clock",
    (dateFormat, clockFormat, expected) => {
      expect(
        formatPickerDateTime("2026-10-10T14:08", dateFormat, clockFormat),
      ).toBe(expected);
    },
  );
  it("formats leap-day midnight without adding an instant or device timezone", () => {
    expect(formatPickerDateTime("2024-02-29T00:00", "LONG", "12")).toBe(
      "Thu 29th February 2024 12:00 am",
    );
    expect(formatPickerDateTime("2026-03-29T01:30", "ISO", "24")).toBe(
      "2026-03-29 01:30",
    );
  });
  it("replaces only the date, including leap dates and repeated autumn wall times", () => {
    expect(replacePickerDate("2026-10-10T23:59", "2024-02-29")).toBe(
      "2024-02-29T23:59",
    );
    expect(replacePickerDate("2026-03-29T01:30", "2026-10-25")).toBe(
      "2026-10-25T01:30",
    );
  });
  it("replaces only the time without rolling the date across midnight", () => {
    expect(replacePickerTime("2026-12-31T23:59", "00:00")).toBe(
      "2026-12-31T00:00",
    );
    expect(replacePickerTime("2024-02-29T00:00", "23:59")).toBe(
      "2024-02-29T23:59",
    );
  });
  it("displays second-precision saved timestamps without mutating their value", () => {
    const stored = "2026-10-10T14:08:37";
    expect(formatPickerDateTime(stored, "LONG_ISO", "12")).toBe(
      "Sat 2026 October 10 02:08 pm",
    );
    expect(stored).toBe("2026-10-10T14:08:37");
  });
  it.each(["00", "37", "59"])(
    "preserves seconds :%s during a date-only edit",
    (seconds) => {
      expect(
        replacePickerDate(`2026-10-10T23:59:${seconds}`, "2024-02-29"),
      ).toBe(`2024-02-29T23:59:${seconds}`);
    },
  );
  it("sets minute precision only when the user explicitly changes the clock", () => {
    expect(replacePickerTime("2026-10-10T14:08:37", "23:59")).toBe(
      "2026-10-10T23:59",
    );
  });
  it.each([
    "2026-02-29T12:00",
    "2026-04-31T12:00",
    "2026-10-10T24:00",
    "2026-10-10T12:00Z",
    "2026-10-10T12:00:60",
    "2026-10-10T12:00:30.5",
    "2026-10-10 12:00",
  ])("rejects invalid or noncanonical local datetime %s", (value) => {
    expect(() => formatPickerDateTime(value)).toThrow(RangeError);
    expect(() => replacePickerDate(value, "2026-10-11")).toThrow(RangeError);
    expect(() => replacePickerTime(value, "12:30")).toThrow(RangeError);
  });
  it("rejects an invalid replacement without constraining it to another date or time", () => {
    expect(() => replacePickerDate("2026-10-10T12:00", "2026-02-29")).toThrow(
      RangeError,
    );
    expect(() => replacePickerTime("2026-10-10T12:00", "24:00")).toThrow(
      RangeError,
    );
    expect(() =>
      formatPickerDateTime("2026-10-10T12:00", "US" as "UK"),
    ).toThrow(RangeError);
  });
});

describe("picker calendar months", () => {
  it.each([
    ["Monday", 3],
    ["Sunday", 4],
    ["Saturday", 5],
  ] as const)(
    "pads leap February with complete %s-start weeks",
    (firstDay, leading) => {
      const grid = calendarMonthDays("2024-02-20", firstDay);
      expect(grid).toHaveLength(35);
      expect(grid.slice(0, leading)).toEqual(Array(leading).fill(null));
      expect(grid[leading]).toBe("2024-02-01");
      expect(grid[leading + 28]).toBe("2024-02-29");
      expect(grid.slice(leading + 29)).toEqual(
        Array(35 - leading - 29).fill(null),
      );
      expect(grid.filter(Boolean)).toHaveLength(29);
      expect(new Set(grid.filter(Boolean)).size).toBe(29);
    },
  );
  it("keeps an exactly aligned four-week month and does not invent leap days", () => {
    const grid = calendarMonthDays("2026-02-01", "Sunday");
    expect(grid).toHaveLength(28);
    expect(grid[0]).toBe("2026-02-01");
    expect(grid.at(-1)).toBe("2026-02-28");
    expect(grid).not.toContain("2026-02-29");
  });
  it("includes all six weeks when a 31-day month crosses them", () => {
    const grid = calendarMonthDays("2021-05-31", "Sunday");
    expect(grid).toHaveLength(42);
    expect(grid.indexOf("2021-05-01")).toBe(6);
    expect(grid.indexOf("2021-05-31")).toBe(36);
  });
  it.each([
    ["2024-01-31", 1, "2024-02-01"],
    ["2026-03-31", -1, "2026-02-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-31", -1, "2025-12-01"],
    ["2026-10-10", 0, "2026-10-01"],
    ["2026-10-10", 14, "2027-12-01"],
  ] as const)(
    "moves %s by %s months to the first day",
    (anchor, months, expected) => {
      expect(shiftCalendarMonth(anchor, months)).toBe(expected);
    },
  );
  it("rejects invalid dates, week starts and fractional month shifts", () => {
    expect(() => calendarMonthDays("2026-02-29", "Monday")).toThrow(RangeError);
    expect(() => calendarMonthDays("2026-10-10T12:00", "Monday")).toThrow(
      RangeError,
    );
    expect(() => calendarMonthDays("2026-10-10", "Friday" as "Monday")).toThrow(
      RangeError,
    );
    expect(() =>
      calendarMonthDays("2026-10-10", "toString" as "Monday"),
    ).toThrow(RangeError);
    expect(() => shiftCalendarMonth("2026-10-10", 1.5)).toThrow(RangeError);
  });
});
