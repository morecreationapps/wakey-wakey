import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { Clock, RotaEntry, Settings, Task } from "../src/model";
import { beforeShiftSleepPreferences } from "../src/engine/beforeShiftSleep";
import { planPreparation } from "../src/engine/preparation";
import { planShift, planTasks } from "../src/engine/planner";
import { suggestPreparationTask } from "../src/engine/taskSuggestions";
import { addDays, localAt, MINUTE, zonedEpoch } from "../src/engine/time";

const zone = "Europe/London";
const clock = (date = "2026-10-08T09:00"): Clock => ({
  now: () => zonedEpoch(date, zone),
});
const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...newSettings(),
  timezone: zone,
  timezoneConfirmed: true,
  additionalPrepConfirmed: true,
  outboundMin: 15,
  outboundMax: 20,
  arrivalBuffer: 10,
  returnMinutes: 20,
  postWorkMinutes: 30,
  sleepTarget: 420,
  latency: 30,
  windDown: 60,
  earlyWake: null,
  earlyBed: null,
  lateWake: null,
  lateBed: null,
  restWake: null,
  restBed: null,
  beforeEarlyBed: "21:30",
  beforeEarlyWake: "05:00",
  beforeLateBed: "23:30",
  beforeLateWake: "07:00",
  freeMinutes: 0,
  routines: [
    {
      id: "morning",
      name: "Shower and coffee",
      includes: ["shower", "coffee"],
      minutes: 30,
      essential: true,
    },
  ],
  origins: {
    timezone: "entered",
    outboundMin: "entered",
    outboundMax: "entered",
    arrivalBuffer: "entered",
    returnMinutes: "entered",
    postWorkMinutes: "entered",
    sleepTarget: "entered",
    latency: "entered",
    windDown: "entered",
    morning: "entered",
  },
  ...patch,
});
const shift = (
  category: "Early" | "Late" = "Late",
  date = "2026-10-10",
  patch: Partial<RotaEntry> = {},
): RotaEntry => ({
  id: `shift-${date}`,
  date,
  status: "Work",
  category,
  duty: category === "Early" ? "24E" : "24L",
  start: `${date}T${category === "Early" ? "06:00" : "14:08"}`,
  end: `${date}T${category === "Early" ? "14:18" : "22:26"}`,
  timezone: zone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  paidMinutes: null,
  breakMinutes: null,
  ...patch,
});
const unknown = (date = "2026-10-09"): RotaEntry => ({
  ...shift("Early", date),
  id: `unknown-${date}`,
  status: "Unknown",
  start: null,
  end: null,
  duty: "",
});
const base = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  kind: "essential",
  minutes: 30,
  earliest: "2026-10-09T00:00",
  deadline: "2026-10-09T23:59",
  windowStart: "00:00",
  windowEnd: "00:00",
  priority: 2,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: true,
  splittable: false,
  locked: false,
  scheduledStart: null,
  state: "pending",
  linkedShiftId: shift().id,
  ...patch,
});
const at = (plan: ReturnType<typeof planShift>, kind: string) =>
  localAt(plan.events.find((e) => e.kind === kind)!.at, zone);
const savedSuggestion = (
  title: string,
  entries: RotaEntry[],
  s: Settings,
  tasks: Task[] = [],
  patch: Partial<Task> = {},
) => {
  const v = suggestPreparationTask(title, entries, tasks, s, clock(), patch)!;
  return {
    v,
    task: base(title, title, {
      ...v,
      deadline: v.deadline || "2026-10-09T23:59",
      windowStart: v.windowStart || "00:00",
      windowEnd: v.windowEnd || "00:00",
      omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
      ...patch,
    }),
  };
};

describe("separate sleep preferences for the night before a shift", () => {
  it.each([
    ["Early", "06:00", "21:30", "05:00", "20:00", "05:00", "05:30"],
    ["Late", "14:08", "23:30", "07:00", "22:00", "13:08", "13:38"],
  ] as const)(
    "uses the %s pair for a %s shift and preserves work preparation arithmetic",
    (category, _start, bed, wake, shower, prepare, departure) => {
      const entry = shift(category),
        entries = [unknown(), entry],
        s = settings(),
        before = JSON.stringify({ entries, s }),
        plan = planShift(entry, s, entries);
      expect(at(plan, "bedtime")).toBe(`2026-10-09T${bed}`);
      expect(at(plan, "wake")).toBe(`2026-10-10T${wake}`);
      expect(at(plan, "prepare")).toBe(`2026-10-10T${prepare}`);
      expect(at(plan, "departure")).toBe(`2026-10-10T${departure}`);
      const { v, task } = savedSuggestion("Shower for bed", entries, s);
      expect(v.preparationDate).toBe("2026-10-09");
      expect(v.minutes).toBe(30);
      expect(v.earliest).toBe(`2026-10-09T${shower}`);
      expect(v.conflict).toContain(
        "earlier on the preparation day are still unconfirmed",
      );
      const prep = planPreparation(entries, [task], s, clock());
      expect(prep.rows.filter((r) => r.taskId === task.id)).toHaveLength(1);
      expect(prep.shiftPlan).toEqual(planShift(entry, s, entries, [task]));
      expect(JSON.stringify({ entries, s })).toBe(before);
    },
  );
  it("offers reviewable evening tasks without assigning next-day waking to the preparation day", () => {
    const entry = shift(),
      entries = [unknown(), entry],
      s = settings({ lateBed: "12:30", lateWake: "08:30" }),
      before = JSON.stringify(s),
      tasks: Task[] = [];
    for (const title of [
      "Shower for bed",
      "Iron my clothes",
      "Haircut",
      "Last meal before bed",
    ]) {
      const { v, task } = savedSuggestion(title, entries, s, tasks);
      expect(v.scheduledStart).not.toBeNull();
      expect(v.earliest.slice(0, 10)).toBe("2026-10-09");
      expect(v.conflict).toContain(
        "provisional timings near the bedtime routine",
      );
      tasks.push(task);
    }
    const p = planPreparation(entries, [...tasks].reverse(), s, clock()),
      timed = p.rows.filter((r) => r.at !== null);
    expect(timed.map((r) => r.at)).toEqual(
      timed.map((r) => r.at).sort((a, b) => a! - b!),
    );
    for (let i = 1; i < timed.length; i++)
      expect(timed[i - 1].end! <= timed[i].at!, JSON.stringify(timed)).toBe(
        true,
      );
    expect(new Set(p.rows.map((r) => r.id)).size).toBe(p.rows.length);
    expect(
      planTasks([tasks[1]], entries, s, clock()).find(
        (p) => p.taskId === tasks[1].id,
      )?.start,
    ).toBeNull();
    expect(JSON.stringify(s)).toBe(before);
    expect(s.restWake).toBeNull();
    expect(s.restBed).toBeNull();
    expect(at(p.shiftPlan!, "wake")).toBe("2026-10-10T07:00");
  });
  it("retains fixed appointments and explicitly edited task values", () => {
    const entry = shift(),
      entries = [unknown(), entry],
      s = settings(),
      booking = base("booked", "Booked haircut", {
        kind: "fixed",
        earliest: "2026-10-09T22:00",
        scheduledStart: "2026-10-09T22:00",
        locked: true,
        movable: false,
      }),
      before = JSON.stringify(booking);
    const { v } = savedSuggestion("Shower for bed", entries, s, [booking]);
    expect(v.earliest).toBe("2026-10-09T21:30");
    const manual = savedSuggestion("Shower for bed", entries, s, [booking], {
      minutes: 25,
      earliest: "2026-10-09T21:17",
      scheduledStart: "2026-10-09T21:17",
      deadline: "2026-10-09T21:50",
    });
    expect(manual.v.minutes).toBe(25);
    expect(manual.v.earliest).toBe("2026-10-09T21:17");
    expect(manual.v.deadline).toBe("2026-10-09T21:50");
    expect(manual.v.preparationAutoStart).toBe(false);
    const p = planPreparation(entries, [booking, manual.task], s, clock());
    expect(
      localAt(p.rows.find((r) => r.taskId === booking.id)!.at!, zone),
    ).toBe("2026-10-09T22:00");
    expect(
      localAt(p.rows.find((r) => r.taskId === manual.task.id)!.at!, zone),
    ).toBe("2026-10-09T21:17");
    expect(JSON.stringify(booking)).toBe(before);
  });
  it("flags an inadequate pair and a wake after preparation while preserving the full target", () => {
    const entry = shift("Early"),
      entries = [unknown(), entry],
      s = settings({ beforeEarlyBed: "23:00", beforeEarlyWake: "06:30" }),
      before = JSON.stringify(s),
      p = planShift(entry, s, entries);
    expect(at(p, "prepare")).toBe("2026-10-10T05:00");
    expect(at(p, "wake")).toBe("2026-10-10T05:00");
    expect(at(p, "bedtime")).toBe("2026-10-09T21:30");
    expect(p.conflicts.join(" ")).toContain("after required preparation");
    expect(p.conflicts.join(" ")).toContain("only 330 minutes");
    expect(p.conflicts.join(" ")).toContain("target has not been shortened");
    const v = suggestPreparationTask(
      "Shower for bed",
      entries,
      [],
      s,
      clock(),
    )!;
    expect(v.conflict).toContain("only 330 minutes");
    expect(JSON.stringify(s)).toBe(before);
  });
  it("honours an earlier adequate bedtime rather than ignoring it", () => {
    const entry = shift("Early"),
      s = settings({ beforeEarlyBed: "20:30" }),
      p = planShift(entry, s, [unknown(), entry]);
    expect(at(p, "bedtime")).toBe("2026-10-09T20:30");
    expect(at(p, "sleepStart")).toBe("2026-10-09T21:00");
    expect(
      (p.events.find((e) => e.kind === "wake")!.at -
        p.events.find((e) => e.kind === "sleepStart")!.at) /
        MINUTE,
    ).toBe(480);
    expect(s.sleepTarget).toBe(420);
  });
  it("preserves the exact legacy plan when both new fields for the selected category are blank", () => {
    const entry = shift("Early"),
      entries = [unknown(), entry],
      legacy = settings({
        earlyBed: "20:30",
        earlyWake: "05:00",
        beforeEarlyBed: undefined,
        beforeEarlyWake: undefined,
        beforeLateBed: undefined,
        beforeLateWake: undefined,
      }),
      old = planShift(entry, legacy, entries);
    expect(
      planShift(
        entry,
        {
          ...legacy,
          beforeEarlyBed: null,
          beforeEarlyWake: null,
          beforeLateBed: "23:30",
          beforeLateWake: "07:00",
        },
        entries,
      ),
    ).toEqual(old);
  });
  it("uses independent fallback for a partially entered pair", () => {
    const entry = shift(),
      entries = [unknown(), entry],
      legacy = settings({
        lateWake: "08:00",
        beforeLateBed: "23:30",
        beforeLateWake: null,
      }),
      p = planShift(entry, legacy, entries);
    expect(at(p, "wake")).toBe("2026-10-10T08:00");
    expect(at(p, "bedtime")).toBe("2026-10-09T23:30");
    const wakeOnly = planShift(
      entry,
      settings({ beforeLateBed: null, beforeLateWake: "07:00" }),
      entries,
    );
    expect(at(wakeOnly, "bedtime")).toBe("2026-10-09T23:30");
  });
  it("binds a new bedtime to the previous calendar date without rolling it to the shift date", () => {
    const entry = shift(),
      s = settings({ beforeLateBed: "00:30" }),
      preference = beforeShiftSleepPreferences(
        entry,
        s,
        zonedEpoch(entry.start!, zone),
      )!;
    expect(localAt(preference.bedtime!, zone)).toBe("2026-10-09T00:30");
    expect(preference.preparationDate).toBe("2026-10-09");
  });
  it.each([
    ["2026-10-25", 480, "21:30"],
    ["2026-03-29", 360, "20:30"],
  ] as const)(
    "measures the %s sleep opportunity in elapsed DST minutes",
    (date, opportunity, bed) => {
      const entry = shift("Early", date),
        s = settings(),
        p = planShift(entry, s, [unknown(addDays(date, -1)), entry]);
      expect(at(p, "bedtime")).toBe(`${addDays(date, -1)}T${bed}`);
      expect(
        (p.events.find((e) => e.kind === "wake")!.at -
          p.events.find((e) => e.kind === "sleepStart")!.at) /
          MINUTE,
      ).toBeGreaterThanOrEqual(420);
      if (opportunity < 420)
        expect(p.conflicts.join(" ")).toContain(`only ${opportunity} minutes`);
      else
        expect(
          p.conflicts.some((c) => c.includes("target has not been shortened")),
        ).toBe(false);
    },
  );
  it.each(["2026-10-25", "2026-03-29"])(
    "requires review for an ambiguous or nonexistent %s preference without inheriting duty disambiguation",
    (date) => {
      const entry = shift("Early", date, { disambiguation: "earlier" }),
        s = settings({ beforeEarlyWake: "01:30" }),
        entries = [unknown(addDays(date, -1)), entry],
        p = planShift(entry, s, entries);
      expect(p.events.some((e) => e.kind === "wake")).toBe(false);
      expect(p.missing.join(" ")).toContain(
        "Review wake time before an early shift",
      );
      const v = suggestPreparationTask(
        "Shower for bed",
        entries,
        [],
        s,
        clock(addDays(date, -2) + "T09:00"),
      )!;
      expect(v.preparationDate).toBe(addDays(date, -1));
      expect(v.scheduledStart).toBeNull();
      expect(v.conflict).toContain("Review wake time before an early shift");
    },
  );
  it("keeps split provisional prerequisites chronological and ironing after the last laundry part", () => {
    const entry = shift(),
      entries = [{ ...unknown(), status: "Rest" as const }, entry],
      s = settings(),
      first = base("first", "Booked commitment", {
        kind: "fixed",
        earliest: "2026-10-09T21:00",
        scheduledStart: "2026-10-09T21:00",
        minutes: 30,
        movable: false,
        locked: true,
      }),
      second = base("second", "Booked commitment", {
        kind: "fixed",
        earliest: "2026-10-09T22:00",
        scheduledStart: "2026-10-09T22:00",
        minutes: 15,
        movable: false,
        locked: true,
      }),
      laundry = base("laundry", "Laundry", {
        minutes: 90,
        earliest: "2026-10-09T20:00",
        deadline: "2026-10-09T22:30",
        splittable: true,
        preparationAutoStart: true,
      }),
      iron = base("iron", "Iron my clothes", {
        minutes: 15,
        earliest: "2026-10-09T20:00",
        deadline: "2026-10-09T22:30",
        preparationAutoStart: true,
      });
    const placements = planTasks(
        [first, second, laundry, iron],
        entries,
        s,
        clock(),
        3,
        { beforeShiftId: entry.id },
      ),
      l = placements.find((p) => p.taskId === laundry.id)!,
      i = placements.find((p) => p.taskId === iron.id)!;
    expect(l.parts!.length).toBeGreaterThan(1);
    expect(l.parts!.map((p) => p.start)).toEqual(
      l.parts!.map((p) => p.start).sort((a, b) => a - b),
    );
    expect(l.start!).toBeLessThan(l.end!);
    expect(i.start).not.toBeNull();
    expect(i.start!).toBeGreaterThanOrEqual(
      Math.max(...l.parts!.map((p) => p.end)),
    );
  });
  it("keeps the missing-rest exemption restricted to tasks linked to the selected preparation shift", () => {
    const entry = shift(),
      entries = [{ ...unknown(), status: "Rest" as const }, entry],
      s = settings(),
      linked = base("linked", "Iron my clothes", {
        preparationAutoStart: true,
      }),
      unlinked = base("unlinked", "General household chore", {
        linkedShiftId: undefined,
      });
    const p = planTasks([linked, unlinked], entries, s, clock(), 3, {
      beforeShiftId: entry.id,
    });
    expect(p.find((p) => p.taskId === linked.id)?.start).not.toBeNull();
    expect(p.find((p) => p.taskId === unlinked.id)?.start).toBeNull();
    expect(p.find((p) => p.taskId === unlinked.id)?.reason).toContain(
      "only to preparation tasks linked",
    );
  });
  it("flags a new wake after recorded work even when missing preparation inputs prevent computing the earlier required wake", () => {
    const entry = shift(),
      s = settings({ outboundMax: null, beforeLateWake: "17:00" }),
      p = planShift(entry, s, [unknown(), entry]);
    expect(p.events.some((e) => e.kind === "prepare")).toBe(false);
    expect(p.events.some((e) => e.kind === "wake")).toBe(false);
    expect(p.conflicts.join(" ")).toContain(
      "later than the recorded work start",
    );
    expect(p.events.some((e) => e.kind === "bedtime")).toBe(false);
  });
  it("also rejects a new wake after known required arrival when travel inputs are missing", () => {
    const entry = shift(),
      s = settings({ outboundMax: null, beforeLateWake: "14:00" }),
      p = planShift(entry, s, [unknown(), entry]);
    expect(at(p, "arrival")).toBe("2026-10-10T13:58");
    expect(p.events.some((e) => e.kind === "wake")).toBe(false);
    expect(p.events.some((e) => e.kind === "bedtime")).toBe(false);
    expect(p.conflicts.join(" ")).toContain(
      "later than the known required arrival or departure time",
    );
  });
  it.each([
    ["Early", { beforeEarlyBed: "21:30", beforeEarlyWake: null }, "20:00"],
    ["Late", { beforeLateBed: null, beforeLateWake: "07:00" }, "22:00"],
  ] as const)(
    "supports a partial %s override throughout suggestions with ordinary rest settings empty",
    (category, patch, shower) => {
      const entry = shift(category),
        entries = [unknown(), entry],
        s = settings(patch),
        v = suggestPreparationTask("Shower for bed", entries, [], s, clock())!;
      expect(v.earliest).toBe(`2026-10-09T${shower}`);
      const iron = suggestPreparationTask(
        "Iron my clothes",
        entries,
        [],
        s,
        clock(),
      )!;
      expect(iron.scheduledStart).not.toBeNull();
      expect(iron.conflict).toContain(
        "usual wake fallback for any blank field",
      );
      expect(s.restWake).toBeNull();
    },
  );
  it("calculates the live-shaped profile with separate pre-shift preferences without changing its ordinary late/recovery fields", () => {
    const entry = shift(),
      entries = [unknown(), entry],
      s = settings({
        lateBed: "12:30",
        lateWake: "08:30",
        earlyBed: null,
        earlyWake: null,
        restBed: null,
        restWake: null,
        additionalPrepConfirmed: false,
        returnMinutes: null,
        postWorkMinutes: null,
        freeMinutes: 120,
        origins: {
          ...newSettings().origins,
          morning: "entered",
          beforeEarlyBed: "entered",
          beforeEarlyWake: "entered",
          beforeLateBed: "entered",
          beforeLateWake: "entered",
        },
      }),
      before = JSON.stringify(s),
      tasks: Task[] = [];
    for (const [title, expected] of [
      ["Shower for bed", "22:00"],
      ["Wind down", "22:30"],
      ["Go to sleep", "23:30"],
      ["Last meal before bed", "21:30"],
    ]) {
      const { v, task } = savedSuggestion(title, entries, s, tasks);
      expect(v.earliest).toBe(`2026-10-09T${expected}`);
      expect(v.conflict).toContain("still unconfirmed");
      tasks.push(task);
    }
    for (const title of [
      "Iron work clothes",
      "Haircut",
      "Prepare lunch",
      "Pack work bag",
      "Laundry",
      "Lay out clothes",
      "Grocery shopping",
      "Batch cooking",
      "Exercise",
      "Personal project",
    ]) {
      const v = suggestPreparationTask(title, entries, tasks, s, clock())!;
      expect(v.scheduledStart, title).not.toBeNull();
      expect(v.earliest.slice(0, 10)).toBe("2026-10-09");
      expect(v.conflict).toContain("still unconfirmed");
    }
    expect(JSON.stringify(s)).toBe(before);
  });
});
