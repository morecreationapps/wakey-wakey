import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { RotaEntry, Settings, Task } from "../src/model";
import {
  planPreparation,
  PreparationPlan,
  PreparationRow,
} from "../src/engine/preparation";
import { planShift } from "../src/engine/planner";
import { shiftDayPanels } from "../src/engine/shiftDayPanels";
import { addDays, localAt, MINUTE, zonedEpoch } from "../src/engine/time";

const zone = "Europe/London";
const at = (local: string, timezone = zone) => zonedEpoch(local, timezone);
const settings = (): Settings => ({
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
  beforeEarlyBed: "21:30",
  beforeEarlyWake: "05:00",
  beforeLateBed: "23:30",
  beforeLateWake: "07:00",
  freeMinutes: 0,
  routines: [
    {
      id: "prep",
      name: "Shower and coffee",
      includes: ["shower", "coffee"],
      minutes: 30,
      essential: true,
    },
  ],
  origins: Object.fromEntries(
    [
      "timezone",
      "outboundMin",
      "outboundMax",
      "arrivalBuffer",
      "returnMinutes",
      "postWorkMinutes",
      "sleepTarget",
      "latency",
      "windDown",
      "prep",
    ].map((key) => [key, "entered"]),
  ),
});
const entry = (
  category: "Early" | "Late" = "Late",
  date = "2026-10-10",
  patch: Partial<RotaEntry> = {},
): RotaEntry => ({
  id: `shift-${date}`,
  date,
  category,
  status: "Work",
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
const task = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  kind: "essential",
  minutes: 30,
  earliest: "2026-10-09T00:00",
  deadline: "2026-10-10T23:59",
  windowStart: "00:00",
  windowEnd: "00:00",
  priority: 1,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: true,
  splittable: false,
  locked: false,
  scheduledStart: null,
  state: "pending",
  linkedShiftId: entry().id,
  ...patch,
});
const row = (
  saved: Task,
  time: string | null,
  patch: Partial<PreparationRow> = {},
): PreparationRow => ({
  id: `task:${saved.id}:once`,
  taskId: saved.id,
  label: saved.title,
  kind: "task",
  at: time ? at(time) : null,
  end: time ? at(time) + saved.minutes * MINUTE : null,
  minutes: saved.minutes,
  status: "pending",
  why: "Saved editable time.",
  ...patch,
});
function preparation(
  shift = entry(),
  savedTasks: Task[] = [],
  s = settings(),
): PreparationPlan {
  return planPreparation(
    [shift],
    savedTasks,
    s,
    { now: () => at(`${addDays(shift.date, -2)}T09:00`) },
    { selectedShift: shift },
  );
}

// Assertions compare the canonical plan's instants, not just matching UI strings.
describe("date-specific Shift Transition and Shift Plan projections", () => {
  it.each(["Early", "Late"] as const)(
    "splits the %s plan by its two local dates and preserves the full planner",
    (category) => {
      const shift = entry(category),
        s = settings(),
        p = preparation(shift, [], s),
        original = structuredClone(p);
      const panels = shiftDayPanels(p, [], s);
      expect(panels.preparationDate).toBe("2026-10-09");
      expect(panels.shiftDate).toBe("2026-10-10");
      expect(panels.transitionRows.map((r) => r.kind)).toEqual(
        category === "Early"
          ? ["windDown", "bedtime", "sleepStart"]
          : ["windDown", "bedtime"],
      );
      expect(panels.shiftRows.map((r) => r.kind)).toContain("workStart");
      for (const [date, rows] of [
        [panels.preparationDate, panels.transitionRows],
        [panels.shiftDate, panels.shiftRows],
      ] as const) {
        expect(
          rows.every((r) => localAt(r.at!, zone).slice(0, 10) === date),
        ).toBe(true);
        for (const r of rows) {
          const e = p.shiftPlan!.events.find((e) => e.kind === r.kind)!;
          expect({ at: r.at, label: r.label, why: r.why }).toEqual({
            at: e.at,
            label: e.label,
            why: e.why,
          });
        }
      }
      expect(p).toEqual(original);
      expect(p.shiftPlan).toEqual(planShift(shift, s, [shift], []));
    },
  );

  it("puts a midnight sleep start on the shift date, while the bedtime stays on Friday", () => {
    const panels = shiftDayPanels(preparation(), [], settings());
    expect(
      localAt(
        panels.transitionRows.find((r) => r.kind === "bedtime")!.at!,
        zone,
      ),
    ).toBe("2026-10-09T23:30");
    expect(
      localAt(panels.shiftRows.find((r) => r.kind === "sleepStart")!.at!, zone),
    ).toBe("2026-10-10T00:00");
    expect(panels.transitionRows.some((r) => r.kind === "sleepStart")).toBe(
      false,
    );
  });

  it.each(["2026-03-29", "2026-10-25"])(
    "uses the previous calendar date across London DST on %s",
    (date) => {
      const shift = entry("Early", date),
        p = preparation(shift),
        panels = shiftDayPanels(p, [], settings());
      expect(panels.preparationDate).toBe(addDays(date, -1));
      expect(panels.transitionRows.length).toBeGreaterThan(0);
      expect(
        panels.transitionRows.every(
          (r) => localAt(r.at!, zone).slice(0, 10) === addDays(date, -1),
        ),
      ).toBe(true);
      expect(
        panels.shiftRows.every(
          (r) => localAt(r.at!, zone).slice(0, 10) === date,
        ),
      ).toBe(true);
    },
  );

  it("uses the shift's timezone even when settings use another timezone and entry.date is stale", () => {
    const shift = entry("Late", "2026-10-10", {
      date: "2026-10-09",
      timezone: "Pacific/Auckland",
      start: "2026-10-10T06:00",
      end: "2026-10-10T14:18",
    });
    const p = preparation();
    p.nextShift = shift;
    p.shiftPlan = {
      ...p.shiftPlan!,
      entryId: shift.id,
      events: [
        {
          kind: "bedtime",
          label: "Bedtime",
          at: at("2026-10-09T21:30", shift.timezone),
          why: "Calculated bedtime.",
        },
        {
          kind: "workStart",
          label: "Start work",
          at: at("2026-10-10T06:00", shift.timezone),
          why: "Recorded shift.",
        },
      ],
    };
    const panels = shiftDayPanels(p, [], settings());
    expect(panels.timezone).toBe("Pacific/Auckland");
    expect(panels.shiftDate).toBe("2026-10-10");
    expect(panels.transitionRows.map((r) => r.kind)).toEqual(["bedtime"]);
    expect(panels.shiftRows.map((r) => r.kind)).toEqual(["workStart"]);
  });

  it("replaces all generated transition stages, while retaining actual scheduled saved tasks in order", () => {
    const shower = task("shower", "Shower for bed"),
      iron = task("iron", "Iron clothes"),
      p = preparation();
    p.rows = [
      row(shower, "2026-10-09T22:00"),
      {
        ...row(iron, "2026-10-09T16:00"),
        taskId: undefined,
        id: "obsolete-generated-stage",
      },
      row(iron, "2026-10-09T18:00"),
    ];
    const panels = shiftDayPanels(p, [shower, iron], settings());
    expect(panels.transitionRows.map((r) => r.label)).toEqual([
      "Iron clothes",
      "Shower for bed",
      ...p
        .shiftPlan!.events.filter((e) =>
          localAt(e.at, zone).startsWith("2026-10-09"),
        )
        .map((e) => e.label),
    ]);
    expect(
      panels.transitionRows.some((r) => r.id === "obsolete-generated-stage"),
    ).toBe(false);
  });

  it.each([
    ["Go to sleep", "bedtime", "2026-10-09T23:30"],
    ["Wind down", "windDown", "2026-10-09T22:30"],
  ])(
    "merges a same-time %s task into the canonical row, including its completion state",
    (title, kind, time) => {
      const saved = task("routine", title, { state: "completed" }),
        p = preparation();
      p.rows = [
        row(saved, time, { kind, status: "completed", conflict: "Task note." }),
      ];
      const panels = shiftDayPanels(p, [saved], settings()),
        matches = panels.transitionRows.filter((r) => r.kind === kind);
      expect(matches).toHaveLength(1);
      expect(matches[0].label).toBe(
        p.shiftPlan!.events.find((e) => e.kind === kind)!.label,
      );
      expect(matches[0]).toMatchObject({
        taskId: saved.id,
        status: "completed",
        conflict: "Task note.",
      });
      expect(matches[0].why).toContain(
        p.shiftPlan!.events.find((e) => e.kind === kind)!.why,
      );
      expect(matches[0].why).toContain(`Saved task: ${title}.`);
    },
  );

  it("retains both the protected calculated bedtime and a conflicting manually chosen bedtime", () => {
    const saved = task("manual-bed", "Go to sleep"),
      p = preparation();
    p.rows = [
      row(saved, "2026-10-09T22:30", {
        kind: "bedtime",
        status: "conflict",
        conflict: "Chosen bedtime differs from calculated bedtime.",
      }),
    ];
    const panels = shiftDayPanels(p, [saved], settings());
    expect(
      panels.transitionRows
        .filter((r) => r.kind === "bedtime")
        .map((r) => localAt(r.at!, zone)),
    ).toEqual(["2026-10-09T22:30", "2026-10-09T23:30"]);
    expect(
      panels.transitionRows.find((r) => r.taskId === saved.id)?.conflict,
    ).toContain("Chosen bedtime");
  });

  it("shows a shift-day appointment from placements once and does not misdate unscheduled or outside-day tasks", () => {
    const fixed = task("fixed", "Appointment", { kind: "fixed" }),
      pending = task("pending", "Needs a time"),
      outside = task("outside", "Another date");
    const p = preparation();
    p.rows = [row(pending, null), row(outside, "2026-10-08T16:00")];
    p.placements = [
      {
        taskId: fixed.id,
        start: at("2026-10-10T09:00"),
        end: at("2026-10-10T09:30"),
        reason: "Fixed appointment time retained.",
      },
      {
        taskId: fixed.id,
        start: at("2026-10-10T09:00"),
        end: at("2026-10-10T09:30"),
        reason: "Repeated snapshot.",
      },
      { taskId: pending.id, start: null, end: null, reason: "Needs input." },
    ];
    const panels = shiftDayPanels(p, [fixed, pending, outside], settings());
    expect(panels.shiftRows.filter((r) => r.taskId === fixed.id)).toHaveLength(
      1,
    );
    expect(panels.transitionRows.some((r) => r.taskId)).toBe(false);
    expect(panels.reviewRows.map((r) => r.taskId)).toEqual([
      outside.id,
      pending.id,
    ]);
    expect(
      panels.reviewRows.find((r) => r.taskId === pending.id)!.at,
    ).toBeNull();
    expect(
      localAt(
        panels.reviewRows.find((r) => r.taskId === outside.id)!.at!,
        zone,
      ),
    ).toBe("2026-10-08T16:00");
  });

  it("deduplicates a saved task already in preparation rows but keeps a different daily occurrence", () => {
    const daily = task("daily", "Prepare lunch", {
        recurrence: "daily",
        occurrenceStates: { "2026-10-10": "accepted" },
      }),
      p = preparation();
    p.rows = [row(daily, "2026-10-09T12:00", { occurrenceDate: "2026-10-09" })];
    p.placements = [
      {
        taskId: daily.id,
        occurrenceDate: "2026-10-09",
        start: at("2026-10-09T12:00"),
        end: at("2026-10-09T12:30"),
        reason: "Previous-day occurrence.",
      },
      {
        taskId: daily.id,
        occurrenceDate: "2026-10-10",
        start: at("2026-10-10T12:00"),
        end: at("2026-10-10T12:30"),
        reason: "Shift-day occurrence.",
      },
    ];
    const panels = shiftDayPanels(p, [daily], settings());
    expect(
      panels.transitionRows.filter((r) => r.taskId === daily.id),
    ).toHaveLength(1);
    expect(panels.shiftRows.filter((r) => r.taskId === daily.id)).toHaveLength(
      1,
    );
    expect(panels.shiftRows.find((r) => r.taskId === daily.id)!.status).toBe(
      "accepted",
    );
  });

  it("keeps overnight finishes outside both date panels and in the untouched detailed sleep plan", () => {
    const shift = entry("Late", "2026-10-10", {
        start: "2026-10-10T22:00",
        end: "2026-10-11T06:00",
      }),
      p = preparation(shift),
      original = structuredClone(p.shiftPlan);
    const panels = shiftDayPanels(p, [], settings());
    const finish = p.shiftPlan!.events.find((e) => e.kind === "workEnd")!;
    expect(panels.otherShiftEvents.some((r) => r.at === finish.at)).toBe(true);
    expect(panels.shiftRows.some((r) => r.at === finish.at)).toBe(false);
    expect(p.shiftPlan).toEqual(original);
  });

  it("does not mutate deeply frozen task, settings, or plan inputs", () => {
    const saved = task("sleep", "Go to sleep"),
      s = settings(),
      p = preparation();
    p.rows = [row(saved, "2026-10-09T23:30", { kind: "bedtime" })];
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(p);
    freeze(saved);
    freeze(s);
    expect(() => shiftDayPanels(p, [saved], s)).not.toThrow();
  });

  it("ignores stale/deleted tasks, another shift's tasks and mismatched canonical plans", () => {
    const deleted = task("deleted", "Deleted task"),
      another = task("other", "Other shift", { linkedShiftId: "other-shift" }),
      p = preparation();
    p.rows = [
      row(deleted, "2026-10-09T18:00"),
      row(another, "2026-10-09T19:00"),
    ];
    p.shiftPlan!.entryId = "other-shift";
    const panels = shiftDayPanels(p, [another], settings());
    expect(panels.transitionRows).toEqual([]);
    expect(panels.shiftRows).toEqual([]);
  });

  it("does not invent dates when there is no valid selected shift start", () => {
    const p = preparation();
    p.nextShift!.start = "invalid";
    const panels = shiftDayPanels(p, [], settings());
    expect(panels.shiftDate).toBeUndefined();
    expect(panels.preparationDate).toBeUndefined();
    expect(panels.transitionRows).toEqual([]);
    expect(panels.shiftRows).toEqual([]);
  });
});
