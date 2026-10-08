import { describe, expect, it } from "vitest";
import { initialState, newSettings } from "../src/data/defaults";
import { exportBackup, parseBackup } from "../src/data/backup";
import { Clock, RotaEntry, Settings, Task } from "../src/model";
import {
  completePreparationTask,
  planPreparation,
} from "../src/engine/preparation";
import { planShift, planTasks, transitions } from "../src/engine/planner";
import { addDays, localAt, MINUTE, zonedEpoch } from "../src/engine/time";

const timezone = "Europe/London";
const today = "2026-10-10",
  tomorrow = "2026-10-11";
const clock = (local = `${today}T09:00`): Clock => ({
  now: () => zonedEpoch(local, timezone),
});
const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...newSettings(),
  timezoneConfirmed: true,
  additionalPrepConfirmed: true,
  outboundMin: 15,
  outboundMax: 20,
  arrivalBuffer: 10,
  returnMinutes: 20,
  sleepTarget: 480,
  latency: 30,
  windDown: 60,
  postWorkMinutes: 30,
  earlyWake: "05:00",
  earlyBed: "20:30",
  lateWake: "08:00",
  lateBed: "00:30",
  restWake: "07:00",
  restBed: "23:00",
  freeMinutes: 120,
  routines: [
    {
      id: "combined",
      name: "Shower and coffee",
      includes: ["shower", "coffee"],
      essential: true,
      minutes: 30,
    },
  ],
  origins: {
    timezone: "entered",
    outboundMin: "entered",
    outboundMax: "entered",
    arrivalBuffer: "entered",
    returnMinutes: "entered",
    sleepTarget: "entered",
    latency: "entered",
    windDown: "entered",
    postWorkMinutes: "entered",
    combined: "entered",
  },
  ...patch,
});
const work = (date = tomorrow, patch: Partial<RotaEntry> = {}): RotaEntry => ({
  id: `work-${date}`,
  date,
  duty: "Synthetic duty",
  category: "Early",
  status: "Work",
  start: `${date}T06:00`,
  end: `${date}T14:18`,
  timezone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  breakMinutes: null,
  paidMinutes: null,
  ...patch,
});
const rest = (date = today, patch: Partial<RotaEntry> = {}): RotaEntry => ({
  ...work(date),
  id: `rest-${date}`,
  status: "Rest",
  duty: "",
  start: null,
  end: null,
  ...patch,
});
const task = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  kind: "flexible",
  minutes: 30,
  earliest: `${today}T09:00`,
  deadline: `${today}T19:00`,
  windowStart: "09:00",
  windowEnd: "19:00",
  priority: 1,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: true,
  splittable: false,
  locked: false,
  scheduledStart: null,
  state: "pending",
  ...patch,
});
describe("preparation checklist completion", () => {
  it("does not complete a recurring series without a selected occurrence", () => {
    const recurring = task("daily", "Prepare lunch", {
      kind: "essential",
      recurrence: "daily",
      deadline: `${tomorrow}T19:00`,
      occurrenceStates: { "2026-10-09": "completed" },
    });
    const plan = planPreparation(
      [rest(today)],
      [recurring],
      settings(),
      clock(),
    );
    expect(plan.placements).toEqual([]);
    expect(completePreparationTask(recurring)).toBe(recurring);
    expect(recurring.state).toBe("pending");
    expect(recurring.occurrenceStates).toEqual({ "2026-10-09": "completed" });
  });

  it("completes only the selected recurring occurrence and retains other dates", () => {
    const recurring = task("daily", "Prepare lunch", {
      recurrence: "daily",
      occurrenceStates: { "2026-10-09": "completed", "2026-10-11": "deferred" },
    });
    const updated = completePreparationTask(recurring, today);
    expect(updated.id).toBe(recurring.id);
    expect(updated.state).toBe("pending");
    expect(updated.occurrenceStates).toEqual({
      "2026-10-09": "completed",
      "2026-10-10": "completed",
      "2026-10-11": "deferred",
    });
    expect(recurring.occurrenceStates?.[today]).toBeUndefined();
  });

  it("retains one-off task completion behaviour", () => {
    const oneOff = task("once", "Pack work bag");
    expect(completePreparationTask(oneOff)).toEqual({
      ...oneOff,
      state: "completed",
    });
    expect(oneOff.state).toBe("pending");
  });
});

const savedTasks = () => [
  task("laundry", "Laundry", { minutes: 45 }),
  task("iron", "Iron work clothes", { minutes: 20, priority: 3 }),
  task("lunch", "Prepare lunch", { minutes: 25 }),
  task("pack", "Pack work bag", { minutes: 10, priority: 3 }),
  task("haircut", "Haircut", {
    kind: "fixed",
    minutes: 30,
    scheduledStart: `${today}T11:30`,
    travelMinutes: 15,
    movable: false,
  }),
  task("completed", "Lay out clothes", {
    state: "completed",
    scheduledStart: `${today}T08:30`,
    minutes: 10,
  }),
];
const placement = (results: ReturnType<typeof planTasks>, id: string) =>
  results.find((p) => p.taskId === id)!;

describe("one preparation view of the existing scheduling data", () => {
  it("shows Rest today and the actual tomorrow duty with chronological saved tasks and distinct full sleep stages", () => {
    const entries = [rest(), work()];
    const prep = planPreparation(entries, savedTasks(), settings(), clock());
    expect(prep.todayStatus).toBe("Rest");
    expect(prep.nextShift?.id).toBe(work().id);
    expect(prep.preparesFor).toBe("tomorrow");
    const timed = prep.rows.filter((row) => row.at !== null);
    expect(timed.map((r) => r.at)).toEqual(
      timed.map((r) => r.at).sort((a, b) => a! - b!),
    );
    const sleep = prep.rows.find((r) => r.kind === "sleepStart")!;
    expect(localAt(sleep.at!, timezone)).toBe(`${today}T21:00`);
    expect(localAt(sleep.end!, timezone)).toBe(`${tomorrow}T05:00`);
    expect(sleep.minutes).toBe(480);
    expect(prep.rows.find((r) => r.kind === "bedtime")?.at).toBe(
      zonedEpoch(`${today}T20:30`, timezone),
    );
    expect(prep.rows.find((r) => r.kind === "windDown")?.at).toBe(
      zonedEpoch(`${today}T19:30`, timezone),
    );
    expect(prep.rows.find((r) => r.kind === "wake")?.at).toBe(sleep.end);
    expect(prep.rows.find((r) => r.taskId === "completed")).toMatchObject({
      status: "completed",
      at: null,
      end: null,
    });
    expect(prep.rows.filter((r) => r.routineId)).toHaveLength(1);
    expect(prep.rows.some((r) => r.kind === "prepare")).toBe(false);
    expect(prep.provisional).toBe(false);
  });

  it("uses later work after consecutive rest and confirmed leave rather than inventing tomorrow's duty", () => {
    const entries = [
      rest(),
      rest(tomorrow),
      rest("2026-10-12", { status: "Holiday", leaveApproval: "confirmed" }),
      work("2026-10-13"),
    ];
    const prep = planPreparation(entries, [], settings(), clock());
    expect(prep.nextShift?.date).toBe("2026-10-13");
    expect(prep.preparesFor).toBe("later");
    expect(prep.rows.every((r) => !r.taskId)).toBe(true);
    expect(prep.shiftPlan?.events.find((e) => e.kind === "workStart")?.at).toBe(
      zonedEpoch("2026-10-13T06:00", timezone),
    );
  });

  it("a future Rest entry leaves today's Work status intact", () => {
    const entry = work(today, {
      start: `${today}T14:00`,
      end: `${today}T22:00`,
      category: "Late",
    });
    const prep = planPreparation(
      [entry, rest(tomorrow), work("2026-10-12")],
      [],
      settings(),
      clock(),
    );
    expect(prep.todayStatus).toBe("Work");
    expect(prep.nextShift?.id).toBe(entry.id);
    expect(prep.preparesFor).toBe("today");
  });

  it("a still-active overnight duty takes precedence over today's Rest entry", () => {
    const overnight = work("2026-10-09", {
      start: "2026-10-09T22:00",
      end: `${today}T10:00`,
      category: "Night",
    });
    const prep = planPreparation(
      [overnight, rest(), work()],
      [],
      settings(),
      clock(),
    );
    expect(prep.todayStatus).toBe("Work");
    expect(prep.nextShift?.date).toBe(tomorrow);
  });

  it("provides a same-type preparation plan even when there is no transition object", () => {
    const entries = [work("2026-10-09"), rest(), work()];
    expect(transitions(entries, settings(), clock())).toEqual([]);
    const prep = planPreparation(
      entries,
      [task("lunch", "Prepare lunch")],
      settings(),
      clock(),
    );
    expect(prep.rows.some((r) => r.taskId === "lunch" && r.at !== null)).toBe(
      true,
    );
    expect(prep.rows.some((r) => r.kind === "sleepStart")).toBe(true);
  });

  it("returns no invented timeline when no future Work is recorded", () => {
    const prep = planPreparation(
      [work("2026-10-09"), rest()],
      savedTasks(),
      settings(),
      clock(),
    );
    expect(prep.nextShift).toBeUndefined();
    expect(prep.shiftPlan).toBeUndefined();
    expect(prep.preparesFor).toBe("none");
    expect(prep.rows).toEqual([]);
  });

  it.each([null, "2026-10-11T99:00"])(
    "surfaces incomplete/invalid earlier Work (%s) before claiming the next duty",
    (start) => {
      const prep = planPreparation(
        [rest(), work(tomorrow, { start }), work("2026-10-12")],
        [],
        settings(),
        clock(),
      );
      expect(prep.nextShift).toBeUndefined();
      expect(prep.rows).toEqual([]);
      expect(prep.missing.join(" ")).toContain(
        "Review the recorded work start",
      );
      expect(prep.provisional).toBe(true);
    },
  );

  it("respects an explicit autumn DST disambiguation on a saved duty", () => {
    const entry = work("2026-10-25", {
      start: "2026-10-25T01:30",
      end: "2026-10-25T08:30",
      disambiguation: "later",
    });
    const prep = planPreparation(
      [rest("2026-10-24"), entry],
      [],
      settings(),
      clock("2026-10-24T09:00"),
    );
    expect(prep.nextShift?.id).toBe(entry.id);
    expect(
      prep.missing.some((m) => m.includes("identify your next shift")),
    ).toBe(false);
  });

  it("labels tomorrow using the recorded duty timezone, while flagging mixed settings", () => {
    const entry = work(tomorrow, { timezone: "America/Los_Angeles" });
    const prep = planPreparation([entry], [], settings(), {
      now: () => Date.parse("2026-10-10T23:30:00Z"),
    });
    expect(prep.today).toBe(tomorrow);
    expect(prep.preparesFor).toBe("tomorrow");
    expect(prep.missing.join(" ")).toContain("differs from current settings");
  });

  it("reuses the exact supplied ShiftPlan and placements and leaves the whole saved state untouched", () => {
    const state = {
      ...initialState(),
      settings: settings(),
      entries: [rest(), work()],
      tasks: savedTasks(),
    };
    const before = JSON.stringify(state);
    const shiftPlan = planShift(
      state.entries[1],
      state.settings,
      state.entries,
      state.tasks,
    );
    const placements = planTasks(
      state.tasks,
      state.entries,
      state.settings,
      clock(),
    );
    const placementBefore = JSON.stringify(placements);
    const prep = planPreparation(
      state.entries,
      state.tasks,
      state.settings,
      clock(),
      { shiftPlan, placements },
    );
    expect(prep.shiftPlan).toBe(shiftPlan);
    expect(prep.rows.find((r) => r.kind === "wake")?.at).toBe(
      shiftPlan.events.find((e) => e.kind === "wake")?.at,
    );
    expect(JSON.stringify(state)).toBe(before);
    expect(parseBackup(exportBackup(state))).toEqual(state);
    expect(JSON.stringify(placements)).toBe(placementBefore);
    expect(new Set(prep.rows.map((r) => r.id)).size).toBe(prep.rows.length);
    expect(state.tasks).toHaveLength(6);
  });

  it("uses the next actual duty and its task placements beyond the default fourteen-day horizon", () => {
    const date = "2026-10-30",
      entry = work(date),
      entries: RotaEntry[] = [];
    for (let day = today; day < date; day = addDays(day, 1))
      entries.push(rest(day));
    entries.push(entry);
    const lunch = task("lunch", "Prepare lunch", {
      earliest: "2026-10-29T09:00",
      deadline: "2026-10-29T19:00",
      linkedShiftId: entry.id,
    });
    const short = planTasks([lunch], entries, settings(), clock());
    expect(placement(short, "lunch").start).toBeNull();
    const prep = planPreparation(entries, [lunch], settings(), clock(), {
      placements: short,
    });
    expect(prep.nextShift?.id).toBe(entry.id);
    expect(prep.rows.find((r) => r.taskId === "lunch")?.at).toBe(
      zonedEpoch("2026-10-29T09:00", timezone),
    );
    expect(placement(prep.placements, "lunch").start).toBe(
      prep.rows.find((r) => r.taskId === "lunch")?.at,
    );
  });

  it("recalculates shift/routine/task edits without changing completion or booked appointment values", () => {
    const tasks = savedTasks(),
      entries = [rest(), work()];
    const before = planPreparation(entries, tasks, settings(), clock());
    const changedTasks = tasks.map((t) =>
      t.id === "laundry" ? { ...t, minutes: 90 } : t,
    );
    const changedEntries = entries.map((e) =>
      e.status === "Work" ? { ...e, start: `${tomorrow}T07:00` } : e,
    );
    const after = planPreparation(
      changedEntries,
      changedTasks,
      settings({ earlyWake: "06:00" }),
      clock(),
    );
    expect(after.rows.find((r) => r.taskId === "laundry")?.minutes).toBe(90);
    expect(after.rows.find((r) => r.taskId === "iron")?.at).toBeGreaterThan(
      before.rows.find((r) => r.taskId === "iron")!.at!,
    );
    expect(after.rows.find((r) => r.kind === "wake")?.at).toBe(
      zonedEpoch(`${tomorrow}T06:00`, timezone),
    );
    expect(after.rows.find((r) => r.taskId === "haircut")?.at).toBe(
      zonedEpoch(`${today}T11:30`, timezone),
    );
    expect(changedTasks.find((t) => t.id === "haircut")?.scheduledStart).toBe(
      `${today}T11:30`,
    );
    expect(changedTasks.find((t) => t.id === "completed")?.state).toBe(
      "completed",
    );
    expect(after.rows.filter((r) => r.taskId === "completed")).toHaveLength(1);
  });

  it("does not invent durations or split a combined routine into unknown activity times", () => {
    const missing = planPreparation(
      [rest(), work()],
      [],
      settings({
        routines: [
          {
            id: "prep",
            name: "Shower and coffee",
            includes: ["shower", "coffee"],
            minutes: null,
            essential: true,
          },
        ],
      }),
      clock(),
    );
    expect(missing.rows.filter((r) => r.routineId)).toEqual([]);
    expect(missing.missing.join(" ")).toContain(
      "Duration for Shower and coffee",
    );
    const known = planPreparation(
      [rest(), work()],
      [],
      settings({ origins: { ...settings().origins, combined: "suggested" } }),
      clock(),
    );
    expect(known.rows.filter((r) => r.routineId)).toHaveLength(1);
    expect(known.rows.find((r) => r.routineId)?.why).toContain(
      "Suggested editable duration",
    );
    expect(known.missing.join(" ")).toContain("Confirm the suggested duration");
  });

  it("splits essential routine totals exactly once and orders selected lunch before packing", () => {
    const s = settings({
      routines: [
        {
          id: "pack",
          name: "Pack work bag",
          includes: ["packing"],
          minutes: 10,
          essential: true,
        },
        {
          id: "lunch",
          name: "Prepare lunch",
          includes: ["lunch"],
          minutes: 20,
          essential: true,
        },
      ],
    });
    const prep = planPreparation([rest(), work()], [], s, clock());
    const rows = prep.rows.filter((r) => r.routineId);
    expect(rows.map((r) => r.routineId)).toEqual(["lunch", "pack"]);
    expect(rows[0].end).toBe(rows[1].at);
    expect(rows.reduce((sum, r) => sum + r.minutes!, 0)).toBe(30);
    expect(rows[0].at).toBe(
      prep.shiftPlan!.events.find((e) => e.kind === "prepare")!.at,
    );
    expect(rows[1].end).toBe(
      prep.shiftPlan!.events.find((e) => e.kind === "departure")!.at,
    );
    expect(prep.rows.some((r) => r.kind === "prepare")).toBe(false);
  });

  it("withholds invalid overlapping routine subdivisions", () => {
    const s = settings({
      routines: [
        {
          id: "one",
          name: "Combined",
          includes: ["coffee"],
          minutes: 30,
          essential: true,
        },
        {
          id: "two",
          name: "Breakfast",
          includes: ["coffee"],
          minutes: 15,
          essential: true,
        },
      ],
    });
    const prep = planPreparation([rest(), work()], [], s, clock());
    expect(prep.rows.filter((r) => r.routineId)).toEqual([]);
    expect(prep.missing.join(" ")).toContain("cannot be counted twice");
  });

  it("never schedules attention tasks into work, appointment travel, full sleep or preparation", () => {
    const prep = planPreparation(
      [rest(), work()],
      savedTasks(),
      settings(),
      clock(),
    );
    const busy = [
      [
        zonedEpoch(`${today}T11:15`, timezone),
        zonedEpoch(`${today}T12:00`, timezone),
      ],
      [
        zonedEpoch(`${today}T19:30`, timezone),
        zonedEpoch(`${tomorrow}T05:00`, timezone),
      ],
      [
        zonedEpoch(`${tomorrow}T05:00`, timezone),
        zonedEpoch(`${tomorrow}T14:38`, timezone),
      ],
    ];
    for (const row of prep.rows.filter(
      (r) => r.taskId && r.taskId !== "haircut" && r.at !== null,
    ))
      for (const [start, end] of busy)
        expect(row.end! <= start || row.at! >= end).toBe(true);
    expect(prep.rows.find((r) => r.taskId === "haircut")?.why).toContain(
      "15 minutes of entered travel",
    );
  });

  it("shows missing saved duration as input needed and does not create an example haircut", () => {
    const prep = planPreparation(
      [rest(), work()],
      [task("lunch", "Prepare lunch", { minutes: 0 })],
      settings(),
      clock(),
    );
    expect(prep.rows.find((r) => r.taskId === "lunch")).toMatchObject({
      at: null,
      status: "needs-input",
    });
    expect(prep.missing.join(" ")).toContain("positive task duration");
    expect(prep.rows.some((r) => r.label === "Haircut")).toBe(false);
  });
});

describe("saved task prerequisites without changing fixed bookings or sleep", () => {
  const entries = () => [rest(), work()];
  it.each([
    ["Laundry", "Iron work clothes"],
    ["Prepare lunch", "Pack work bag"],
    ["Prepare lunch", "Pack lunch"],
  ])("finishes %s before higher-priority %s", (first, second) => {
    const tasks = [
      task("after", second, { priority: 100 }),
      task("before", first, { minutes: 45, priority: 0 }),
    ];
    const result = planTasks(tasks, entries(), settings(), clock());
    expect(placement(result, "before").end).not.toBeNull();
    expect(placement(result, "after").start).toBeGreaterThanOrEqual(
      placement(result, "before").end!,
    );
  });

  it("waits until every split prerequisite part is finished", () => {
    const result = planTasks(
      [
        task("iron", "Iron work clothes", { priority: 10 }),
        task("laundry", "Laundry", { minutes: 90, splittable: true }),
        task("appointment", "Fixed appointment", {
          kind: "fixed",
          movable: false,
          scheduledStart: `${today}T09:30`,
          minutes: 60,
        }),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "laundry").parts).toHaveLength(2);
    expect(placement(result, "iron").start).toBeGreaterThanOrEqual(
      placement(result, "laundry").parts!.at(-1)!.end,
    );
  });

  it("shows both an impossible prerequisite and its dependent rather than ironing first", () => {
    const result = planTasks(
      [
        task("iron", "Iron work clothes", { priority: 10 }),
        task("laundry", "Laundry", { minutes: 90, windowEnd: "10:00" }),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "laundry").start).toBeNull();
    expect(placement(result, "iron").start).toBeNull();
    expect(placement(result, "iron").reason).toContain("Laundry");
    expect(placement(result, "iron").reason).toContain("move or defer");
  });

  it.each(["skipped", "deferred"] as const)(
    "keeps a %s prerequisite visible and blocks its dependent",
    (state) => {
      const prep = planPreparation(
        entries(),
        [
          task("laundry", "Laundry", { state }),
          task("iron", "Iron work clothes"),
        ],
        settings(),
        clock(),
      );
      expect(prep.rows.find((r) => r.taskId === "laundry")).toMatchObject({
        status: state,
        at: null,
      });
      expect(prep.rows.find((r) => r.taskId === "iron")).toMatchObject({
        status: "needs-input",
        at: null,
      });
      expect(prep.conflicts.join(" ")).toContain(state);
    },
  );

  it("uses completed laundry without placing it again", () => {
    const result = planTasks(
      [
        task("laundry", "Laundry", { state: "completed" }),
        task("iron", "Iron work clothes"),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(result.some((p) => p.taskId === "laundry")).toBe(false);
    expect(placement(result, "iron").start).toBe(
      zonedEpoch(`${today}T09:00`, timezone),
    );
  });

  it("recognises a completed recurring prerequisite occurrence without rescheduling it or showing future duplicates", () => {
    const laundry = task("laundry", "Laundry", {
      recurrence: "daily",
      occurrenceStates: { [today]: "completed" },
    });
    const iron = task("iron", "Iron work clothes", {
      recurrence: "daily",
      priority: 10,
    });
    const prep = planPreparation(
      entries(),
      [laundry, iron],
      settings(),
      clock(),
    );
    expect(prep.rows.find((r) => r.taskId === "laundry")).toMatchObject({
      occurrenceDate: today,
      status: "completed",
      at: null,
    });
    expect(prep.rows.find((r) => r.taskId === "iron")?.at).toBe(
      zonedEpoch(`${today}T09:00`, timezone),
    );
    expect(prep.rows.filter((r) => r.taskId === "laundry")).toHaveLength(1);
  });

  it("a completed recurring occurrence also permits a one-off dependant on the same date", () => {
    const result = planTasks(
      [
        task("laundry", "Laundry", {
          recurrence: "daily",
          occurrenceStates: { [today]: "completed" },
        }),
        task("iron", "Iron work clothes"),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "iron").start).not.toBeNull();
  });

  it("retains an impossible fixed dependent at its booked time and reports the prerequisite conflict", () => {
    const ironing = task("iron", "Iron work clothes", {
      kind: "fixed",
      movable: false,
      scheduledStart: `${today}T09:15`,
      minutes: 20,
    });
    const result = planTasks(
      [task("laundry", "Laundry", { minutes: 45 }), ironing],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "iron").start).toBe(
      zonedEpoch(`${today}T09:15`, timezone),
    );
    expect(placement(result, "iron").conflict).toContain("Laundry");
    expect(placement(result, "laundry").start).toBeNull();
    expect(ironing.scheduledStart).toBe(`${today}T09:15`);
  });

  it("keeps fixed laundry and orders ironing after it, including a reserved travel allowance", () => {
    const result = planTasks(
      [
        task("laundry", "Laundry", {
          kind: "fixed",
          movable: false,
          scheduledStart: `${today}T11:30`,
          minutes: 45,
        }),
        task("iron", "Iron work clothes", { priority: 100, travelMinutes: 15 }),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "laundry").start).toBe(
      zonedEpoch(`${today}T11:30`, timezone),
    );
    expect(placement(result, "iron").start).toBe(
      zonedEpoch(`${today}T12:30`, timezone),
    );
  });

  it("does not infer a prerequisite from unrelated dates or different linked duties", () => {
    const result = planTasks(
      [
        task("laundry", "Laundry", {
          earliest: "2026-10-15T09:00",
          deadline: "2026-10-15T19:00",
        }),
        task("iron", "Iron work clothes"),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(result, "iron").start).toBe(
      zonedEpoch(`${today}T09:00`, timezone),
    );
    const linked = planTasks(
      [
        task("laundry", "Laundry", {
          linkedShiftId: "different",
          state: "deferred",
        }),
        task("iron", "Iron work clothes", { linkedShiftId: work().id }),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(placement(linked, "iron").start).not.toBeNull();
  });

  it("does not place a saved packing task before a selected lunch-preparation routine", () => {
    const s = settings({
      routines: [
        {
          id: "lunch-routine",
          name: "Prepare lunch",
          includes: ["lunch preparation"],
          minutes: 30,
          essential: true,
        },
      ],
    });
    const pack = task("pack", "Pack work bag", { linkedShiftId: work().id });
    const result = planTasks([pack], entries(), s, clock());
    expect(placement(result, "pack").start).toBeNull();
    expect(placement(result, "pack").reason).toContain("Prepare lunch");
    expect(placement(result, "pack").reason).toContain(
      "instead of scheduling it first",
    );
    const fixed = {
      ...pack,
      kind: "fixed" as const,
      movable: false,
      scheduledStart: `${today}T10:00`,
    };
    const retained = planTasks([fixed], entries(), s, clock());
    expect(placement(retained, "pack").start).toBe(
      zonedEpoch(`${today}T10:00`, timezone),
    );
    expect(placement(retained, "pack").conflict).toContain("Prepare lunch");
  });

  it("surfaces a missing routine prerequisite duration instead of placing its saved dependent", () => {
    const s = settings({
      routines: [
        {
          id: "laundry-routine",
          name: "Laundry",
          includes: ["laundry"],
          minutes: null,
          essential: true,
        },
      ],
    });
    const prep = planPreparation(
      entries(),
      [task("iron", "Iron work clothes", { linkedShiftId: work().id })],
      s,
      clock(),
    );
    expect(prep.rows.find((r) => r.taskId === "iron")?.at).toBeNull();
    expect(prep.conflicts.join(" ")).toContain("Laundry");
    expect(prep.missing.join(" ")).toContain("Duration for Laundry");
  });

  it("keeps independent tasks' existing priority order", () => {
    const result = planTasks(
      [
        task("low", "Read", { priority: 0 }),
        task("high", "Exercise", { priority: 5 }),
      ],
      entries(),
      settings(),
      clock(),
    );
    expect(result.map((p) => p.taskId)).toEqual(["high", "low"]);
  });
});
