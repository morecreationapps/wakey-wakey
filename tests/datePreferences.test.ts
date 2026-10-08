import { describe, expect, it } from "vitest";
import { displayDate, displayLocalDateTime } from "../src/engine/time";
import { initialState } from "../src/data/defaults";
import { exportBackup, parseBackup } from "../src/data/backup";
import { exportCSV, importAccepted, previewImport } from "../src/data/import";
import { AppState, Settings } from "../src/model";

function savedPlanner(): AppState {
  return {
    ...initialState(),
    entries: [
      {
        id: "synthetic-rest",
        date: "2026-10-10",
        duty: "",
        category: "Custom",
        status: "Rest",
        start: null,
        end: null,
        timezone: "Europe/London",
        overtimeMinutes: 0,
        location: "",
        notes: "Synthetic saved note",
        breakMinutes: null,
        paidMinutes: null,
      },
    ],
  };
}

describe("date display preferences", () => {
  it("formats recorded local timestamps without moving their date or time", () => {
    expect(displayLocalDateTime("2026-10-10T14:08", "LONG")).toBe(
      "Sat 10th October 2026 14:08",
    );
    expect(displayLocalDateTime("2026-10-11T00:26:30", "LONG")).toBe(
      "Sun 11th October 2026 00:26:30",
    );
    expect(displayLocalDateTime("2026-10-10T14:08", "LONG_ISO")).toBe(
      "Sat 2026 October 10 14:08",
    );
    expect(displayLocalDateTime("2026-10-11T00:26:30", "LONG_ISO")).toBe(
      "Sun 2026 October 11 00:26:30",
    );
    for (const format of ["UK", "ISO"] as const)
      expect(displayLocalDateTime("2026-10-10T14:08", format)).toBe(
        "2026-10-10 14:08",
      );
  });

  it("renders the requested long date exactly", () => {
    expect(displayDate("2026-10-10", "LONG")).toBe("Sat 10th October 2026");
  });

  it("renders Written ISO in the owner's chosen weekday-first order without an ordinal", () => {
    expect(displayDate("2026-10-10", "LONG_ISO")).toBe("Sat 2026 October 10");
    expect(displayDate("2026-10-11", "LONG_ISO")).toBe("Sun 2026 October 11");
    expect(displayDate("2026-10-12", "LONG_ISO")).toBe("Mon 2026 October 12");
    expect(displayDate("2026-10-13", "LONG_ISO")).toBe("Tue 2026 October 13");
    expect(displayDate("2026-10-21", "LONG_ISO")).toBe("Wed 2026 October 21");
  });

  it.each([
    ["2026-10-05", "Mon 2026 October 5"],
    ["2026-10-06", "Tue 2026 October 6"],
    ["2026-10-07", "Wed 2026 October 7"],
    ["2026-10-08", "Thu 2026 October 8"],
    ["2026-10-09", "Fri 2026 October 9"],
    ["2026-10-10", "Sat 2026 October 10"],
    ["2026-10-11", "Sun 2026 October 11"],
  ])("uses the English weekday in Written ISO for %s", (date, expected) => {
    expect(displayDate(date, "LONG_ISO")).toBe(expected);
  });

  it.each([
    ["2026-01-01", "Thu 2026 January 1"],
    ["2026-02-01", "Sun 2026 February 1"],
    ["2026-03-01", "Sun 2026 March 1"],
    ["2026-04-01", "Wed 2026 April 1"],
    ["2026-05-01", "Fri 2026 May 1"],
    ["2026-06-01", "Mon 2026 June 1"],
    ["2026-07-01", "Wed 2026 July 1"],
    ["2026-08-01", "Sat 2026 August 1"],
    ["2026-09-01", "Tue 2026 September 1"],
    ["2026-10-01", "Thu 2026 October 1"],
    ["2026-11-01", "Sun 2026 November 1"],
    ["2026-12-01", "Tue 2026 December 1"],
  ])("uses the full month in Written ISO for %s", (date, expected) => {
    expect(displayDate(date, "LONG_ISO")).toBe(expected);
  });

  it.each([
    ["2026-10-01", "Thu 1st October 2026"],
    ["2026-10-02", "Fri 2nd October 2026"],
    ["2026-10-03", "Sat 3rd October 2026"],
    ["2026-10-04", "Sun 4th October 2026"],
    ["2026-10-11", "Sun 11th October 2026"],
    ["2026-10-12", "Mon 12th October 2026"],
    ["2026-10-13", "Tue 13th October 2026"],
    ["2026-10-14", "Wed 14th October 2026"],
    ["2026-10-20", "Tue 20th October 2026"],
    ["2026-10-21", "Wed 21st October 2026"],
    ["2026-10-22", "Thu 22nd October 2026"],
    ["2026-10-23", "Fri 23rd October 2026"],
    ["2026-10-24", "Sat 24th October 2026"],
    ["2026-10-30", "Fri 30th October 2026"],
    ["2026-10-31", "Sat 31st October 2026"],
  ])("uses the correct ordinal for %s", (date, expected) => {
    expect(displayDate(date, "LONG")).toBe(expected);
  });

  it.each([
    ["2026-10-05", "Mon 5th October 2026"],
    ["2026-10-06", "Tue 6th October 2026"],
    ["2026-10-07", "Wed 7th October 2026"],
    ["2026-10-08", "Thu 8th October 2026"],
    ["2026-10-09", "Fri 9th October 2026"],
    ["2026-10-10", "Sat 10th October 2026"],
    ["2026-10-11", "Sun 11th October 2026"],
  ])("uses the English weekday for %s", (date, expected) => {
    expect(displayDate(date, "LONG")).toBe(expected);
  });

  it.each([
    ["2026-01-01", "Thu 1st January 2026"],
    ["2026-02-01", "Sun 1st February 2026"],
    ["2026-03-01", "Sun 1st March 2026"],
    ["2026-04-01", "Wed 1st April 2026"],
    ["2026-05-01", "Fri 1st May 2026"],
    ["2026-06-01", "Mon 1st June 2026"],
    ["2026-07-01", "Wed 1st July 2026"],
    ["2026-08-01", "Sat 1st August 2026"],
    ["2026-09-01", "Tue 1st September 2026"],
    ["2026-10-01", "Thu 1st October 2026"],
    ["2026-11-01", "Sun 1st November 2026"],
    ["2026-12-01", "Tue 1st December 2026"],
  ])("uses the full English month for %s", (date, expected) => {
    expect(displayDate(date, "LONG")).toBe(expected);
  });

  it("preserves UK, ISO and the default UK display", () => {
    expect(displayDate("2026-10-10", "UK")).toBe("10/10/2026");
    expect(displayDate("2026-10-10", "ISO")).toBe("2026-10-10");
    expect(displayDate("2026-10-10")).toBe("10/10/2026");
    expect(displayDate("2027-01-01", "UK")).toBe("01/01/2027");
    expect(displayDate("2027-01-01", "ISO")).toBe("2027-01-01");
  });

  it("retains real-date validation and handles leap dates", () => {
    expect(displayDate("2024-02-29", "LONG")).toBe("Thu 29th February 2024");
    expect(displayDate("2024-02-29", "LONG_ISO")).toBe("Thu 2024 February 29");
    for (const format of ["LONG", "LONG_ISO"] as const) {
      expect(() => displayDate("2026-02-29", format)).toThrow();
      expect(() => displayDate("2026-04-31", format)).toThrow();
    }
  });
});

describe("saved date and week preferences", () => {
  it("keeps existing UK and Monday defaults", () => {
    const state = initialState();
    expect(state.settings.dateFormat).toBe("UK");
    expect(state.settings.firstDay).toBe("Monday");
  });

  const formats: Settings["dateFormat"][] = ["UK", "ISO", "LONG", "LONG_ISO"];
  const weekStarts: Settings["firstDay"][] = ["Monday", "Sunday", "Saturday"];
  it.each(
    formats.flatMap((format) =>
      weekStarts.map((day) => [format, day] as const),
    ),
  )(
    "round-trips %s and %s without altering saved ISO records",
    (dateFormat, firstDay) => {
      const state = savedPlanner();
      state.settings = { ...state.settings, dateFormat, firstDay };
      const before = JSON.stringify(state);
      const restored = parseBackup(exportBackup(state));
      expect(restored).toEqual(state);
      expect(restored.entries[0].date).toBe("2026-10-10");
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  it("continues to reject unknown date formats and week starts", () => {
    const state = savedPlanner();
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...state,
          settings: { ...state.settings, dateFormat: "US" },
        }),
      ),
    ).toThrow(/settings.dateFormat/);
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...state,
          settings: { ...state.settings, firstDay: "Friday" },
        }),
      ),
    ).toThrow(/settings.firstDay/);
  });
});

describe("display preference does not change input or export date semantics", () => {
  const csv = "date,status\n2026-10-10,Rest";

  it.each(["LONG", "LONG_ISO"] as const)(
    "accepts ISO CSV with %s selected and stores an ISO date",
    (format) => {
      const preview = previewImport(csv, "Europe/London", [], format);
      expect(preview.errors).toEqual([]);
      expect(preview.rows[0].errors).toEqual([]);
      expect(importAccepted(preview, [])[0].date).toBe("2026-10-10");
    },
  );

  it.each(["LONG", "LONG_ISO"] as const)(
    "keeps CSV exports in ISO form when %s is selected",
    (format) => {
      const state = savedPlanner();
      state.settings.dateFormat = format;
      const exported = exportCSV(state.entries);
      expect(exported.split("\r\n")[1].startsWith("2026-10-10,")).toBe(true);
      expect(exported).not.toContain("Sat 10th October 2026");
      expect(exported).not.toContain("Sat 2026 October 10");
      expect(state.entries[0].date).toBe("2026-10-10");
    },
  );

  it.each([undefined, "ISO", "LONG", "LONG_ISO"] as const)(
    "still requires explicit UK selection for ambiguous slash CSV with %s",
    (format) => {
      const preview = previewImport(
        csv.replace("2026-10-10", "10/11/2026"),
        "Europe/London",
        [],
        format,
      );
      expect(preview.rows[0].errors.join(" ")).toMatch(/selecting UK/);
      expect(importAccepted(preview, [])).toEqual([]);
    },
  );

  it("retains explicit UK slash-date order", () => {
    const preview = previewImport(
      csv.replace("2026-10-10", "10/11/2026"),
      "Europe/London",
      [],
      "UK",
    );
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[0].entry?.date).toBe("2026-11-10");
  });

  it.each([
    ["LONG", "Sat 10th October 2026"],
    ["LONG_ISO", "Sat 2026 October 10"],
  ] as const)(
    "does not accept a displayed %s date as an input date",
    (format, shown) => {
      const preview = previewImport(
        csv.replace("2026-10-10", shown),
        "Europe/London",
        [],
        format,
      );
      expect(preview.rows[0].errors.join(" ")).toMatch(/Use YYYY-MM-DD/);
      expect(importAccepted(preview, [])).toEqual([]);
    },
  );

  it.each(["LONG", "LONG_ISO"] as const)(
    "preserves the explicit UK pasted-text grammar with %s selected",
    (format) => {
      const preview = previewImport(
        "10/11/2026: REST",
        "Europe/London",
        [],
        format,
      );
      expect(preview.rows[0].errors).toEqual([]);
      expect(preview.rows[0].entry?.date).toBe("2026-11-10");
    },
  );
});
