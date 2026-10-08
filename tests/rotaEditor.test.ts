import { describe, expect, it } from "vitest";
import type { RotaEntry } from "../src/model";
import { initialState } from "../src/data/defaults";
import { exportBackup, parseBackup } from "../src/data/backup";
import {
  replaceEntry,
  scheduledMinutes,
  validateEntry,
} from "../src/data/rota";
import { moveRotaEntryDate, normaliseRotaEntry } from "../src/ui/rotaEditor";

function duty(patch: Partial<RotaEntry> = {}): RotaEntry {
  return {
    id: "synthetic-night-duty",
    date: "2026-12-31",
    duty: "0009N",
    category: "Night",
    status: "Work",
    start: "2026-12-31T22:08:17",
    end: "2027-01-01T06:26:23",
    actualEnd: "2027-01-01T07:01:29",
    timezone: "Europe/London",
    overtimeMinutes: 15,
    location: "Example workplace",
    notes: "Synthetic note",
    breakMinutes: 30,
    paidMinutes: 480,
    ...patch,
  };
}

describe("rota picker date edits", () => {
  it("moves an overnight duty across a year boundary without flattening finish or losing seconds", () => {
    const before = duty();
    const moved = moveRotaEntryDate(before, "2027-01-31");
    expect(moved).toEqual({
      ...before,
      date: "2027-01-31",
      start: "2027-01-31T22:08:17",
      end: "2027-02-01T06:26:23",
      actualEnd: "2027-02-01T07:01:29",
    });
    expect(validateEntry(moved)).toEqual([]);
    expect(before).toEqual(duty());
  });

  it("keeps a leap-day finish and a later actual finish at their recorded calendar offsets", () => {
    const moved = moveRotaEntryDate(
      duty({ actualEnd: "2027-01-02T00:01:29" }),
      "2028-02-28",
    );
    expect(moved.end).toBe("2028-02-29T06:26:23");
    expect(moved.actualEnd).toBe("2028-03-01T00:01:29");
    expect(validateEntry(moved)).toEqual([]);
  });

  it("keeps a same-day duty on one date and leaves an unknown actual finish unknown", () => {
    const moved = moveRotaEntryDate(
      duty({
        start: "2026-12-31T06:00",
        end: "2026-12-31T14:18",
        actualEnd: null,
      }),
      "2027-05-10",
    );
    expect(moved.start).toBe("2027-05-10T06:00");
    expect(moved.end).toBe("2027-05-10T14:18");
    expect(moved.actualEnd).toBeNull();
    expect(validateEntry(moved)).toEqual([]);
  });

  it("preserves an absent optional actual finish and returns the original object for an unchanged date", () => {
    const original = duty();
    delete original.actualEnd;
    expect(moveRotaEntryDate(original, original.date)).toBe(original);
    expect(moveRotaEntryDate(original, "2027-05-10")).not.toHaveProperty(
      "actualEnd",
    );
  });

  it("moves by calendar date rather than elapsed hours over spring DST", () => {
    const original = duty({
      date: "2026-03-28",
      start: "2026-03-28T22:00",
      end: "2026-03-29T06:00",
      actualEnd: null,
      overtimeMinutes: 0,
    });
    const moved = moveRotaEntryDate(original, "2026-03-29");
    expect(moved.start).toBe("2026-03-29T22:00");
    expect(moved.end).toBe("2026-03-30T06:00");
    expect(scheduledMinutes(original)).toBe(420);
    expect(scheduledMinutes(moved)).toBe(480);
  });

  it("leaves a moved spring-gap time for the existing validator to reject instead of adjusting it", () => {
    const moved = moveRotaEntryDate(
      duty({
        date: "2026-03-28",
        start: "2026-03-28T01:30",
        end: "2026-03-28T06:00",
        actualEnd: null,
        disambiguation: "later",
      }),
      "2026-03-29",
    );
    expect(moved.start).toBe("2026-03-29T01:30");
    expect(validateEntry(moved).join(" ")).toMatch(/does not exist/);
  });

  it("retains the recorded timezone and explicit repeated-time choice", () => {
    const moved = moveRotaEntryDate(
      duty({
        date: "2026-10-24",
        start: "2026-10-24T01:30",
        end: "2026-10-24T06:00",
        actualEnd: null,
        disambiguation: "later",
      }),
      "2026-10-25",
    );
    expect(moved.timezone).toBe("Europe/London");
    expect(moved.disambiguation).toBe("later");
    expect(validateEntry(moved)).toEqual([]);
  });

  it("does not invent an overnight finish when the original same-day boundaries are invalid", () => {
    const moved = moveRotaEntryDate(
      duty({ end: "2026-12-31T06:26", actualEnd: null }),
      "2027-01-15",
    );
    expect(moved.end).toBe("2027-01-15T06:26");
    expect(validateEntry(moved).join(" ")).toMatch(
      /Finish must be after start/,
    );
  });

  it.each(["", "2027-02-29", "15/01/2027"])(
    "rejects an invalid selected date: %s",
    (date) => {
      expect(() => moveRotaEntryDate(duty(), date)).toThrow(/valid rota date/);
    },
  );
});

describe("explicit Rest saves", () => {
  it("clears residual work fields without requiring a duty code or times", () => {
    const original = duty({
      status: "Rest",
      patternId: "synthetic-pattern",
      exception: true,
    });
    const rest = normaliseRotaEntry(original);
    expect(rest).toEqual({
      ...original,
      duty: "",
      start: null,
      end: null,
      actualEnd: null,
      overtimeMinutes: 0,
      breakMinutes: null,
      paidMinutes: null,
    });
    expect(rest.status).toBe("Rest");
    expect(validateEntry(rest)).toEqual([]);
    expect(original.start).toBe("2026-12-31T22:08:17");
  });

  it("round-trips a date-only Rest in the existing backup schema", () => {
    const state = initialState();
    state.entries = [normaliseRotaEntry(duty({ status: "Rest" }))];
    expect(parseBackup(exportBackup(state)).entries).toEqual(state.entries);
  });

  it("still requires a valid Rest date and does not turn it into an Unknown entry", () => {
    const rest = normaliseRotaEntry(duty({ status: "Rest", date: "" }));
    expect(rest.status).toBe("Rest");
    expect(validateEntry(rest).join(" ")).toMatch(/valid ISO date/);
  });

  it("replaces one selected duty with explicit Rest while preserving the other dates", () => {
    const original = duty();
    const other = duty({
      id: "synthetic-other-duty",
      date: "2027-01-04",
      start: "2027-01-04T22:00",
      end: "2027-01-05T06:00",
      actualEnd: null,
    });
    const rest = normaliseRotaEntry({ ...original, status: "Rest" });
    const entries = replaceEntry([original, other], rest);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.id === original.id)?.status).toBe(
      "Rest",
    );
    expect(entries.find((entry) => entry.id === other.id)).toEqual(other);
  });

  it("leaves a Work entry unchanged and preserves unrelated leave pay fields", () => {
    const work = duty();
    expect(normaliseRotaEntry(work)).toBe(work);
    const leave = normaliseRotaEntry(
      duty({ status: "Holiday", leaveApproval: "confirmed" }),
    );
    expect(leave.paidMinutes).toBe(480);
    expect(leave.leaveApproval).toBe("confirmed");
    expect(leave.start).toBeNull();
  });
});
