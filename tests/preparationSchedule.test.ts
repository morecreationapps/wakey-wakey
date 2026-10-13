import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { Clock, RotaEntry, Settings, Task } from "../src/model";
import { planPreparation } from "../src/engine/preparation";
import { planShift } from "../src/engine/planner";
import { shiftDayPanels } from "../src/engine/shiftDayPanels";
import {
  suggestPreparationTask,
  defaultPreparationTaskStart,
} from "../src/engine/taskSuggestions";
import { taskForSaving, snapshotTaskPlacement } from "../src/ui/taskDraft";
import { localAt, zonedEpoch } from "../src/engine/time";

const zone = "Europe/London";
const clock: Clock = { now: () => zonedEpoch("2026-10-09T09:00", zone) };
const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...newSettings(),
  timezone: zone,
  timezoneConfirmed: true,
  additionalPrepConfirmed: true,
  outboundMin: 20,
  outboundMax: 20,
  arrivalBuffer: 10,
  returnMinutes: 20,
  postWorkMinutes: 30,
  sleepTarget: 420,
  latency: 30,
  windDown: 60,
  freeMinutes: 0,
  earlyWake: "05:00",
  earlyBed: "21:30",
  lateBed: "23:30",
  lateWake: "07:00",
  restBed: "23:30",
  restWake: "07:00",
  beforeEarlyBed: "21:30",
  beforeEarlyWake: "05:00",
  beforeLateBed: "23:30",
  beforeLateWake: "07:00",
  routines: [
    {
      id: "morning",
      name: "Shower and breakfast",
      includes: ["shower", "breakfast"],
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
      "morning",
    ].map((k) => [k, "entered"]),
  ),
  ...patch,
});
const shift = (late = false): RotaEntry => ({
  id: "next",
  date: "2026-10-10",
  status: "Work",
  category: late ? "Late" : "Early",
  duty: late ? "24L" : "24E",
  start: `2026-10-10T${late ? "14:08" : "06:00"}`,
  end: `2026-10-10T${late ? "22:26" : "14:18"}`,
  timezone: zone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  breakMinutes: null,
  paidMinutes: null,
});
const entries = (late = false): RotaEntry[] => [
  {
    ...shift(),
    id: "rest",
    date: "2026-10-09",
    status: "Rest",
    start: null,
    end: null,
  },
  shift(late),
];
const task = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  kind: "essential",
  minutes: 30,
  earliest: "2026-10-09T00:00",
  deadline: "2026-10-10T00:00",
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
  linkedShiftId: "next",
  preparationAutoStart: true,
  omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
  ...patch,
});
function draft(
  title: string,
  saved: Task[],
  s = settings(),
  rota = entries(),
  patch: Partial<Task> = {},
) {
  const overrides = { id: title, ...patch };
  const v =
    suggestPreparationTask(
      title,
      rota,
      saved,
      s,
      clock,
      overrides,
      rota.at(-1)!,
    ) ??
    defaultPreparationTaskStart(
      rota,
      saved,
      s,
      clock,
      { ...overrides, title },
      rota.at(-1)!,
    )!;
  return {
    v,
    save: () => taskForSaving(task(title, title, { ...v, ...patch }), zone),
  };
}
function tight() {
  return {
    s: settings({
      restBed: null,
      restWake: null,
      lateBed: "12:30",
      lateWake: "08:30",
      returnMinutes: null,
      postWorkMinutes: null,
    }),
    rota: [
      {
        ...shift(true),
        id: "previous",
        date: "2026-10-08",
        start: "2026-10-08T14:08",
        end: "2026-10-08T22:26",
        overtimeMinutes: 480,
      },
      ...entries(),
    ],
  };
}
const at = (n: number | null) =>
  n === null ? null : localAt(n, zone).slice(11, 16);
function noOverlaps(plan: ReturnType<typeof planPreparation>) {
  const rows = plan.rows.filter(
    (r) =>
      r.taskId &&
      r.at !== null &&
      r.end !== null &&
      !["skipped", "deferred"].includes(r.status),
  );
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      expect(
        rows[i].end! <= rows[j].at! || rows[j].end! <= rows[i].at!,
        `${rows[i].label} / ${rows[j].label}`,
      ).toBe(true);
    }
}

describe("one coordinated preparation schedule", () => {
  it("saves an unscheduled meal once with its conflict, then schedules it when space is available", () => {
    const { s, rota } = tight();
    const iron = draft("Iron work clothes", [], s, rota).save();
    const mealDraft = draft("Last meal before bed", [iron], s, rota);
    expect(mealDraft.v.scheduledStart).toBeNull();
    const meal = taskForSaving(
      task("meal", "Last meal before bed", mealDraft.v),
      zone,
      { date: mealDraft.v.preparationDate, timezone: zone },
    );
    const plan = planPreparation(rota, [iron, meal], s, clock);
    const meals = plan.rows.filter((r) => r.taskId === "meal");
    expect(meals).toHaveLength(1);
    expect(meals[0].at).toBeNull();
    expect(meals[0].conflict).toMatch(/No permitted.*meal slot/);
    const panels = shiftDayPanels(plan, [iron, meal], s);
    expect(
      panels.transitionRows.filter((r) => r.taskId === "meal"),
    ).toHaveLength(1);
    expect(panels.shiftRows.some((r) => r.taskId === "meal")).toBe(false);
    expect(panels.reviewRows.some((r) => r.taskId === "meal")).toBe(false);
    expect(plan.rows.find((r) => r.taskId === iron.id)?.at).not.toBeNull();
    noOverlaps(plan);
    const freePlan = planPreparation(entries(), [meal], settings(), clock);
    expect(freePlan.rows.find((r) => r.taskId === "meal")?.at).not.toBeNull();
    expect(freePlan.rows.find((r) => r.taskId === "meal")?.at).not.toBe(
      zonedEpoch("2026-10-09T00:00", zone),
    );
  });

  it.each([false, true])(
    "coordinates ironing and shower in either addition order before the %s shift",
    (late) => {
      for (const titles of [
        ["Iron work clothes", "Shower for bed"],
        ["Shower for bed", "Iron work clothes"],
      ]) {
        const rota = entries(late),
          saved: Task[] = [],
          s = settings();
        const originalShift = planShift(rota.at(-1)!, s, rota);
        for (const title of titles) {
          const d = draft(title, saved, s, rota);
          saved.push(d.save());
          const p = planPreparation(rota, saved, s, clock);
          expect(
            localAt(p.rows.find((r) => r.taskId === title)!.at!, zone),
          ).toBe(d.v.scheduledStart);
          noOverlaps(p);
        }
        const p = planPreparation(rota, saved, s, clock);
        expect(
          at(p.rows.find((r) => r.taskId === "Iron work clothes")!.at),
        ).toBe(late ? "21:30" : "19:30");
        expect(at(p.rows.find((r) => r.taskId === "Shower for bed")!.at)).toBe(
          late ? "22:00" : "20:00",
        );
        expect(p.shiftPlan?.events).toEqual(originalShift.events);
        expect(p.rows.filter((r) => r.taskId)).toHaveLength(2);
      }
    },
  );

  it.each(["Iron work clothes", "Shower for bed"])(
    "reserves a completed %s interval before suggesting the other activity",
    (title) => {
      const done = task("done", title, {
        scheduledStart: "2026-10-09T19:30",
        earliest: "2026-10-09T19:30",
        state: "completed",
        preparationAutoStart: false,
      });
      const other =
        title === "Iron work clothes" ? "Shower for bed" : "Iron work clothes";
      const d = draft(other, [done]);
      const p = planPreparation(entries(), [done, d.save()], settings(), clock);
      noOverlaps(p);
      expect(at(p.rows.find((r) => r.taskId === "done")!.at)).toBe("19:30");
      expect(at(p.rows.find((r) => r.taskId === other)!.at)).toBe(
        title === "Iron work clothes" ? "20:00" : "19:00",
      );
    },
  );

  it("does not offer a shower before a deliberately timed ironing task or reuse its slot", () => {
    const manual = task("iron", "Iron work clothes", {
      preparationAutoStart: false,
      earliest: "2026-10-09T20:00",
      scheduledStart: "2026-10-09T20:00",
    });
    const d = draft("Shower for bed", [manual]);
    expect(d.v.scheduledStart).toBeNull();
    expect(d.v.conflict).toMatch(/fit|slot|room/i);
    expect(manual.scheduledStart).toBe("2026-10-09T20:00");
  });

  it("flags both retained completed rows in the reported 20:00 collision instead of rewriting history", () => {
    const saved = [
      task("iron", "Iron work clothes"),
      task("shower", "Shower for bed"),
    ].map((t) => ({
      ...t,
      state: "completed" as const,
      scheduledStart: "2026-10-09T20:00",
      preparationAutoStart: false,
    }));
    const p = planPreparation(entries(), saved, settings(), clock);
    for (const row of p.rows.filter((r) => r.taskId)) {
      expect(row.status).toBe("completed");
      expect(at(row.at)).toBe("20:00");
      expect(row.conflict).toMatch(/overlap/i);
    }
    expect(p.conflicts.join(" ")).toMatch(
      /Iron work clothes.*Shower for bed|Shower for bed.*Iron work clothes/,
    );
  });

  it("warns in the draft if a new shower makes an existing movable task unable to fit", () => {
    const { s, rota } = tight();
    const iron = draft("Iron work clothes", [], s, rota).save();
    const d = draft("Shower for bed", [iron], s, rota);
    expect(d.v.conflict).toMatch(/Iron work clothes/);
    const p = planPreparation(rota, [iron, d.save()], s, clock);
    expect(p.rows.find((r) => r.taskId === "Iron work clothes")!.at).toBeNull();
    noOverlaps(p);
  });

  it("does not release the displayed slot on completion", () => {
    const { s, rota } = tight();
    const iron = draft("Iron work clothes", [], s, rota).save();
    const p = planPreparation(rota, [iron], s, clock);
    const done = {
      ...snapshotTaskPlacement(
        iron,
        p.placements.find((r) => r.taskId === iron.id),
        zone,
      ),
      state: "completed" as const,
    };
    expect(
      draft("Shower for bed", [done], s, rota).v.scheduledStart,
    ).toBeNull();
    expect(
      draft("Check work bag", [done], s, rota).v.scheduledStart,
    ).toBeNull();
  });

  it("reserves routine travel and all task durations across multiple additions and completion", () => {
    const s = settings(),
      rota = entries();
    let saved: Task[] = [];
    for (const title of [
      "Iron work clothes",
      "Shower for bed",
      "Lay out clothes",
      "Last meal before bed",
      "Check work bag",
    ]) {
      const d = draft(
        title,
        saved,
        s,
        rota,
        title === "Shower for bed" ? { travelMinutes: 10 } : {},
      );
      expect(d.v.scheduledStart, title).not.toBeNull();
      saved.push(d.save());
      const p = planPreparation(rota, saved, s, clock);
      noOverlaps(p);
      expect(localAt(p.rows.find((r) => r.taskId === title)!.at!, zone)).toBe(
        d.v.scheduledStart,
      );
      const shower = p.rows.find((r) => r.taskId === "Shower for bed");
      if (shower)
        for (const r of p.rows.filter(
          (r) => r.taskId && r.taskId !== shower.taskId,
        ))
          expect(r.end!).toBeLessThanOrEqual(shower.at! - 10 * 60000);
    }
    const before = planPreparation(rota, saved, s, clock);
    saved = saved.map((t) =>
      t.id === "Iron work clothes"
        ? {
            ...snapshotTaskPlacement(
              t,
              before.placements.find((p) => p.taskId === t.id),
              zone,
            ),
            state: "completed" as const,
          }
        : t,
    );
    const after = planPreparation(rota, saved, s, clock);
    noOverlaps(after);
    expect(after.rows.find((r) => r.taskId === "Iron work clothes")!.at).toBe(
      before.rows.find((r) => r.taskId === "Iron work clothes")!.at,
    );
  });

  it("keeps a deliberately overlapping shower time and flags both affected tasks", () => {
    const iron = task("iron", "Iron work clothes", {
      earliest: "2026-10-09T20:00",
      scheduledStart: "2026-10-09T20:00",
      preparationAutoStart: false,
    });
    const d = draft("Shower for bed", [iron], settings(), entries(), {
      earliest: "2026-10-09T20:00",
      scheduledStart: "2026-10-09T20:00",
    });
    expect(d.v.scheduledStart).toBe("2026-10-09T20:00");
    expect(d.v.conflict).toMatch(/overlap/i);
    const p = planPreparation(entries(), [iron, d.save()], settings(), clock);
    expect(
      p.rows
        .filter((r) => r.taskId)
        .every((r) => r.conflict?.match(/overlap/i)),
    ).toBe(true);
  });

  it("checks other-shift fixed commitments that cross into the preparation day", () => {
    const overnight = task("booking", "Overnight commitment", {
      kind: "fixed",
      linkedShiftId: "other-shift",
      scheduledStart: "2026-10-08T23:00",
      earliest: "2026-10-08T23:00",
      deadline: "2026-10-10T10:00",
      minutes: 1290,
      movable: false,
      locked: true,
    });
    expect(draft("Shower for bed", [overnight]).v.scheduledStart).toBeNull();
  });
});
