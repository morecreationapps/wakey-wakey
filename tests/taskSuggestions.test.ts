import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { Clock, RotaEntry, Settings, Task } from "../src/model";
import { planPreparation } from "../src/engine/preparation";
import {
  defaultPreparationTaskStart,
  recognizePreparationActivity,
  suggestPreparationTask,
} from "../src/engine/taskSuggestions";
import { planShift, planTasks } from "../src/engine/planner";
import {
  addDays,
  localAt,
  MINUTE,
  onDate,
  zonedEpoch,
} from "../src/engine/time";

const zone = "Europe/London";
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
  sleepTarget: 480,
  latency: 30,
  windDown: 60,
  earlyWake: "05:00",
  earlyBed: "20:30",
  lateWake: "08:00",
  lateBed: "23:30",
  restWake: "07:00",
  restBed: "23:00",
  freeMinutes: 60,
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
const clock = (date = "2026-10-08T09:00"): Clock => ({
  now: () => zonedEpoch(date, zone),
});
const shift = (
  category: "Early" | "Late" = "Early",
  date = "2026-10-10",
): RotaEntry => ({
  id: `work-${date}`,
  date,
  status: "Work",
  duty: category === "Early" ? "24E" : "24L",
  category,
  start: `${date}T${category === "Early" ? "06:00" : "14:08"}`,
  end: `${date}T${category === "Early" ? "14:18" : "22:26"}`,
  timezone: zone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  breakMinutes: null,
  paidMinutes: null,
});
const rest = (date: string): RotaEntry => ({
  ...shift("Early", date),
  id: `rest-${date}`,
  status: "Rest",
  start: null,
  end: null,
  duty: "",
});
const base = (id: string, title: string, patch: Partial<Task> = {}): Task => ({
  id,
  title,
  kind: "essential",
  minutes: 30,
  earliest: "2026-10-09T09:00",
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
function suggested(
  title: string,
  entry: RotaEntry,
  s: Settings,
  tasks: Task[] = [],
  patch: Partial<Task> = {},
) {
  const entries = [rest(addDays(entry.date, -1)), entry];
  const suggestion = suggestPreparationTask(
    title,
    entries,
    tasks,
    s,
    clock(),
    patch,
    entry,
  )!;
  const dayEnd = onDate(entry.date, "00:00", entry.timezone);
  return {
    suggestion,
    task: base(patch.id ?? title, title, {
      ...suggestion,
      deadline: suggestion.deadline || localAt(dayEnd - MINUTE, s.timezone),
      windowStart: suggestion.windowStart || "00:00",
      windowEnd: suggestion.windowEnd || "00:00",
      omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
      ...patch,
    }),
  };
}

describe("task-aware day-before suggestions", () => {
  it.each([
    "Laundry and iron work clothes",
    "Wash clothes and iron my uniform",
    "Laundry, iron work clothes",
    "Laundry; iron my clothes",
  ])(
    "leaves the combined activity %s for the user's own duration and schedule",
    (title) => {
      expect(recognizePreparationActivity(title)).toBeUndefined();
      expect(
        suggestPreparationTask(
          title,
          [rest("2026-10-09"), shift()],
          [],
          settings(),
          clock(),
        ),
      ).toBeNull();
    },
  );
  it("uses existing suggested values and unconfirmed availability only for an editable preparation suggestion", () => {
    const entry = shift("Late"),
      unknown = { ...rest("2026-10-09"), status: "Unknown" as const },
      entries = [unknown, entry],
      s = settings({
        restBed: null,
        origins: {
          ...settings().origins,
          sleepTarget: "suggested",
          windDown: "suggested",
          outboundMax: "suggested",
        },
      }),
      before = JSON.stringify({ entries, s }),
      v = suggestPreparationTask("Iron my clothes", entries, [], s, clock())!;
    expect(v.preparationDate).toBe("2026-10-09");
    expect(v.earliest.slice(0, 10)).toBe("2026-10-09");
    expect(v.scheduledStart).not.toBeNull();
    expect(v.kind).toBe("essential");
    expect(v.conflict).toContain("existing starting values");
    expect(v.conflict).toContain(
      "Availability on the preparation day is unconfirmed",
    );
    expect(v.conflict).toContain("full sleep target");
    const task = base("iron", "Iron my clothes", {
      ...v,
      deadline: "2026-10-09T23:59",
      windowStart: "00:00",
      windowEnd: "00:00",
      omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
    });
    const p = planPreparation(entries, [task], s, clock());
    expect(p.rows.filter((r) => r.taskId === task.id)).toHaveLength(1);
    expect(
      localAt(p.rows.find((r) => r.taskId === task.id)!.at!, zone).slice(0, 10),
    ).toBe("2026-10-09");
    expect(p.rows.find((r) => r.taskId === task.id)?.conflict).toContain(
      "unconfirmed",
    );
    expect(p.shiftPlan).toEqual(planShift(entry, s, entries, [task]));
    expect(
      planTasks(
        [task],
        entries,
        s,
        { now: () => onDate("2026-10-09", "00:00", zone) },
        2,
      ).find((p) => p.taskId === task.id)?.start,
    ).toBeNull();
    expect(JSON.stringify({ entries, s })).toBe(before);
  });
  it("protects fixed commitments when the preparation day's availability is unconfirmed", () => {
    const entry = shift("Early"),
      s = settings(),
      entries = [{ ...rest("2026-10-09"), status: "Unknown" as const }, entry],
      fixed = base("booking", "Booked haircut", {
        kind: "fixed",
        earliest: "2026-10-09T19:00",
        scheduledStart: "2026-10-09T19:00",
        minutes: 30,
        movable: false,
        locked: true,
      }),
      v = suggestPreparationTask(
        "Shower for bed",
        entries,
        [fixed],
        s,
        clock(),
      )!;
    expect(v.earliest).toBe("2026-10-09T18:30");
    expect(v.conflict).toContain("unconfirmed");
    const shower = base("shower", "Shower for bed", {
        ...v,
        deadline: "2026-10-09T23:59",
        windowStart: "00:00",
        windowEnd: "00:00",
      }),
      p = planPreparation(entries, [fixed, shower], s, clock());
    expect(p.rows.find((r) => r.taskId === fixed.id)?.at).toBe(
      zonedEpoch("2026-10-09T19:00", zone),
    );
    expect(p.rows.find((r) => r.taskId === shower.id)?.end).toBe(
      p.rows.find((r) => r.taskId === fixed.id)?.at,
    );
    expect(p.shiftPlan).toEqual(planShift(entry, s, entries, [fixed, shower]));
  });
  it("retains an entered bedtime task timestamp when missing wake inputs prevent reviewing the routine", () => {
    const entry = shift("Late"),
      s = settings({ lateWake: null, restWake: null, consistentWake: false }),
      entries = [{ ...rest("2026-10-09"), status: "Unknown" as const }, entry],
      shower = base("entered", "Shower for bed", {
        kind: "fixed",
        earliest: "2026-10-09T22:24",
        scheduledStart: "2026-10-09T22:24",
        locked: true,
        movable: false,
        preparationAutoStart: false,
      }),
      before = JSON.stringify(shower),
      p = planPreparation(entries, [shower], s, clock());
    expect(p.rows.find((r) => r.taskId === shower.id)?.at).toBe(
      zonedEpoch("2026-10-09T22:24", zone),
    );
    expect(p.rows.find((r) => r.taskId === shower.id)?.conflict).toContain(
      "entered start is retained",
    );
    expect(p.shiftPlan).toEqual(planShift(entry, s, entries, [shower]));
    expect(JSON.stringify(shower)).toBe(before);
    const v = suggestPreparationTask(
      "Shower for bed",
      entries,
      [],
      s,
      clock(),
    )!;
    expect(v.preparationDate).toBe("2026-10-09");
    expect(v.earliest).toBe("");
    expect(v.conflict).toMatch(
      /^Enter your usual Late-shift wake time in Settings/,
    );
    expect(v.explanation).toContain("a start time needs the missing inputs");
  });
  it("orders typed ironing aliases after selected laundry and leaves completed laundry completed", () => {
    const entry = shift("Late"),
      s = settings(),
      entries = [rest("2026-10-09"), entry],
      laundry = base("laundry", "Laundry", { minutes: 45, priority: 1 }),
      iron = base("iron", "Iron my clothes", {
        priority: 3,
        preparationAutoStart: true,
      });
    const p = planPreparation(entries, [iron, laundry], s, clock());
    expect(
      p.placements.find((p) => p.taskId === iron.id)!.start,
    ).not.toBeNull();
    expect(
      p.placements.find((p) => p.taskId === iron.id)!.start!,
    ).toBeGreaterThanOrEqual(
      p.placements.find((p) => p.taskId === laundry.id)!.end!,
    );
    const done = planPreparation(
      entries,
      [iron, { ...laundry, state: "completed" }],
      s,
      clock(),
    );
    expect(done.rows.find((r) => r.taskId === laundry.id)?.status).toBe(
      "completed",
    );
    expect(done.placements.some((p) => p.taskId === laundry.id)).toBe(false);
    expect(
      done.placements.find((p) => p.taskId === iron.id)?.start,
    ).not.toBeNull();
  });
  it.each([
    ["Shower", "shower", 30],
    ["Have a shower", "shower", 30],
    ["Shower before bedtime", "shower", 30],
    ["Bedtime shower", "shower", 30],
    ["Iron my clothes", "ironing", 30],
    ["Ironing uniform", "ironing", 30],
    ["Get a hair cut", "haircut", 30],
    ["Cut my hair", "haircut", 30],
    ["Meal before bed", "meal", 30],
    ["Winding down", "windDown", 60],
    ["Sleep", "sleep", 30],
  ] as const)(
    "recognises typed %s and gives the same task-aware previous-day suggestion",
    (title, activity, minutes) => {
      const entry = shift("Late"),
        s = settings();
      expect(recognizePreparationActivity(title)).toBe(activity);
      const v = suggestPreparationTask(
        title,
        [rest("2026-10-09"), entry],
        [],
        s,
        clock(),
      )!;
      expect(v.minutes).toBe(minutes);
      expect(v.preparationDate).toBe("2026-10-09");
      expect(v.scheduledStart).not.toBeNull();
      expect(v.earliest.slice(0, 10)).toBe("2026-10-09");
      expect(v.deadline).toBe("");
      expect(v.windowStart).toBe("");
      expect(v.windowEnd).toBe("");
      expect(v).not.toHaveProperty("location");
    },
  );
  it("keeps the known previous calendar date and task duration when missing personal settings prevent a safe clock suggestion", () => {
    const entry = shift("Late"),
      s = {
        ...newSettings(),
        timezoneConfirmed: true,
        outboundMin: 15,
        outboundMax: 20,
      };
    const before = JSON.stringify(s),
      v = suggestPreparationTask(
        "Shower for bed",
        [rest("2026-10-09"), entry],
        [],
        s,
        clock(),
      )!;
    expect(v.preparationDate).toBe("2026-10-09");
    expect(v.minutes).toBe(30);
    expect(v.earliest).toBe("");
    expect(v.scheduledStart).toBeNull();
    expect(v.conflict).toBeTruthy();
    const iron = suggestPreparationTask(
      "Iron my clothes",
      [rest("2026-10-09"), entry],
      [],
      s,
      clock(),
    )!;
    expect(iron.preparationDate).toBe("2026-10-09");
    expect(iron.minutes).toBe(30);
    expect(iron.earliest).toBe("");
    expect(iron.conflict).toBeTruthy();
    expect(JSON.stringify(s)).toBe(before);
  });
  it.each([
    ["Early", "06:00", "19:00"],
    ["Late", "14:08", "22:00"],
  ] as const)(
    "anchors %s %s preparation to Friday 9th and calculates a 30-minute shower",
    (category, _time, shower) => {
      const entry = shift(category),
        s = settings(),
        entries = [rest("2026-10-09"), entry];
      const { suggestion, task } = suggested("Shower for bed", entry, s);
      expect(suggestion.minutes).toBe(30);
      expect(suggestion.earliest).toBe(`2026-10-09T${shower}`);
      expect(suggestion.scheduledStart).toBe(suggestion.earliest);
      expect(suggestion.deadline).toBe("");
      expect(suggestion.windowStart).toBe("");
      expect(suggestion.windowEnd).toBe("");
      expect(suggestion).not.toHaveProperty("location");
      expect(suggestion).not.toHaveProperty("contact");
      expect(suggestion).not.toHaveProperty("travelMinutes");
      const plan = planPreparation(entries, [task], s, clock());
      expect(plan.preparationDate).toBe("2026-10-09");
      expect(plan.rows.find((r) => r.taskId === task.id)?.at).toBe(
        zonedEpoch(suggestion.earliest, zone),
      );
      expect(
        plan.rows.find((r) => r.taskId === task.id)?.conflict,
      ).toBeUndefined();
      expect(
        plan.rows.some((r) =>
          ["wake", "prepare", "departure", "workStart", "workEnd"].includes(
            r.kind,
          ),
        ),
      ).toBe(false);
      expect(plan.shiftPlan).toEqual(planShift(entry, s, entries, [task]));
    },
  );
  it("changes the shower suggestion when wake time, commute and entered duration change instead of hard-coding 20:30", () => {
    const entry = shift(),
      s = settings({ earlyWake: "04:00", earlyBed: "19:30", outboundMax: 40 });
    const result = suggested("Shower for bed", entry, s, [], {
      minutes: 45,
    }).suggestion;
    expect(result.minutes).toBe(45);
    expect(result.earliest).toBe("2026-10-09T17:45");
    const forced = suggested("Shower for bed", entry, settings(), [], {
      minutes: 45,
      earliest: "2026-10-09T20:00",
      scheduledStart: "2026-10-09T20:00",
    }).suggestion;
    expect(forced.earliest).toBe("2026-10-09T20:00");
    expect(forced.scheduledStart).toBe("2026-10-09T20:00");
    expect(forced.conflict).toContain("overlaps the wind-down");
  });
  it("retains explicit blank optional fields and recognises task-specific durations without inventing booking details", () => {
    const entry = shift("Late"),
      s = settings();
    for (const [title, minutes] of [
      ["Iron clothes", 30],
      ["Haircut", 30],
      ["Last meal before bed", 30],
      ["Wind down", 60],
      ["Go to sleep", 30],
      ["Pack work bag", 10],
    ] as const) {
      const v = suggested(title, entry, s, [], {
        deadline: "",
        windowStart: "",
        windowEnd: "",
      }).suggestion;
      expect(v.minutes).toBe(minutes);
      expect(v.earliest.slice(0, 10)).toBe("2026-10-09");
      expect(v.deadline).toBe("");
      expect(v.windowStart).toBe("");
      expect(v.windowEnd).toBe("");
    }
    expect(recognizePreparationActivity("unrelated activity")).toBeUndefined();
    expect(
      suggestPreparationTask(
        "unrelated activity",
        [rest("2026-10-09"), entry],
        [],
        s,
        clock(),
      ),
    ).toBeNull();
    const generic = defaultPreparationTaskStart(
      [rest("2026-10-09"), entry],
      [],
      s,
      clock(),
      { title: "Call my friend", minutes: 15 },
    );
    expect(generic?.earliest.slice(0, 10)).toBe("2026-10-09");
    expect(generic?.minutes).toBe(15);
    expect(generic).not.toHaveProperty("location");
  });
  it("places saved selected tasks chronologically once and replaces generated bedtime stages", () => {
    const entry = shift(),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const tasks: Task[] = [];
    for (const title of [
      "Go to sleep",
      "Shower for bed",
      "Wind down",
      "Haircut",
      "Iron work clothes",
      "Last meal before bed",
    ]) {
      tasks.push(suggested(title, entry, s, tasks).task);
    }
    const before = JSON.stringify(tasks),
      plan = planPreparation(entries, [...tasks].reverse(), s, clock());
    expect(plan.rows.filter((r) => r.taskId)).toHaveLength(tasks.length);
    expect(plan.rows.filter((r) => r.kind === "windDown")).toHaveLength(1);
    expect(plan.rows.filter((r) => r.kind === "bedtime")).toHaveLength(1);
    const timed = plan.rows.filter((r) => r.at !== null);
    expect(timed.map((r) => r.at)).toEqual(
      timed.map((r) => r.at).sort((a, b) => a! - b!),
    );
    expect(new Set(plan.rows.map((r) => r.id)).size).toBe(plan.rows.length);
    for (let i = 1; i < timed.length; i++)
      expect(timed[i - 1].end! <= timed[i].at!).toBe(true);
    expect(JSON.stringify(tasks)).toBe(before);
  });
  it("moves a shower suggestion earlier around a saved fixed haircut and never changes the appointment", () => {
    const entry = shift(),
      s = settings(),
      appointment = base("appointment", "Haircut", {
        kind: "fixed",
        scheduledStart: "2026-10-09T19:10",
        earliest: "2026-10-09T19:10",
        minutes: 30,
        travelMinutes: 10,
        movable: false,
        locked: true,
      });
    const before = JSON.stringify(appointment),
      { suggestion, task } = suggested("Shower for bed", entry, s, [
        appointment,
      ]);
    expect(suggestion.earliest).toBe("2026-10-09T18:30");
    const plan = planPreparation(
      [rest("2026-10-09"), entry],
      [appointment, task],
      s,
      clock(),
    );
    expect(
      localAt(plan.rows.find((r) => r.taskId === "appointment")!.at!, zone),
    ).toBe("2026-10-09T19:10");
    expect(JSON.stringify(appointment)).toBe(before);
    expect(
      plan.rows.find((r) => r.taskId === "appointment")?.conflict,
    ).toBeTruthy();
  });
  it("flags real appointment and routine conflicts without treating the shift day itself as invalid", () => {
    const entry = shift(),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const shower = base("shower", "Shower for bed", {
      scheduledStart: "2026-10-09T20:00",
      earliest: "2026-10-09T20:00",
      locked: true,
      movable: false,
    });
    const wrong = base("wrong", "Haircut", {
      kind: "fixed",
      earliest: "2026-10-10T11:00",
      scheduledStart: "2026-10-10T11:00",
      deadline: "2026-10-10T23:59",
      locked: true,
      movable: false,
    });
    const sleep = base("sleep", "Go to sleep", {
      scheduledStart: "2026-10-09T20:30",
      earliest: "2026-10-09T20:30",
      minutes: 120,
      omittedFields: ["deadline"],
    });
    const plan = planPreparation(entries, [wrong, shower, sleep], s, clock());
    for (const task of [wrong, shower, sleep]) {
      const row = plan.rows.find((r) => r.taskId === task.id)!,
        p = plan.placements.find((p) => p.taskId === task.id)!;
      expect(row.conflict).toBeTruthy();
      expect(p.conflict).toBe(row.conflict);
      expect(localAt(p.start!, zone)).toBe(task.scheduledStart);
    }
    expect(plan.rows.find((r) => r.taskId === "wrong")?.conflict).toContain(
      "work and travel",
    );
    expect(plan.rows.find((r) => r.taskId === "wrong")?.conflict).not.toContain(
      "calendar day before",
    );
    expect(plan.rows.find((r) => r.taskId === "sleep")?.conflict).toContain(
      "protected planned sleep",
    );
  });
  it("does not invent bedtime when wake settings are missing", () => {
    const entry = shift("Late"),
      s = settings({ lateWake: null, restWake: null, consistentWake: false });
    const { suggestion } = suggested("Shower for bed", entry, s);
    expect(suggestion.scheduledStart).toBeNull();
    expect(suggestion.earliest).toBe("");
    expect(suggestion.conflict).toContain("wake");
  });
  it("uses calendar subtraction across a short DST day and with an overnight selected shift", () => {
    const early = {
      ...shift("Early", "2026-03-30"),
      start: "2026-03-30T00:15",
      end: "2026-03-30T08:15",
    };
    const c = clock("2026-03-28T09:00");
    const p = planPreparation([rest("2026-03-29"), early], [], settings(), c);
    expect(p.preparationDate).toBe("2026-03-29");
    expect(
      localAt(zonedEpoch(early.start!, zone) - 24 * 60 * MINUTE, zone).slice(
        0,
        10,
      ),
    ).toBe("2026-03-28");
    const overnight = {
      ...shift("Late"),
      start: "2026-10-10T23:00",
      end: "2026-10-11T07:00",
    };
    expect(
      planPreparation([rest("2026-10-09"), overnight], [], settings(), clock())
        .preparationDate,
    ).toBe("2026-10-09");
  });
  it("flags preparation that has already passed and gives a same-day new task a future slot", () => {
    const entry = shift(),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const now = clock("2026-10-09T12:15");
    const v = suggestPreparationTask("Iron work clothes", entries, [], s, now)!;
    expect(zonedEpoch(v.earliest, zone)).toBeGreaterThanOrEqual(now.now());
    const past = suggestPreparationTask(
      "Shower for bed",
      entries,
      [],
      s,
      clock("2026-10-10T05:00"),
    )!;
    expect(past.conflict).toContain("in the past");
    expect(past.earliest.slice(0, 10)).toBe("2026-10-09");
  });
  it("keeps previous-day lunch and packing ordered when settings retain a separate shift-morning lunch routine", () => {
    const entry = shift(),
      s = settings({
        routines: [
          ...settings().routines,
          {
            id: "morning-lunch",
            name: "Prepare lunch",
            includes: ["lunch"],
            minutes: 20,
            essential: true,
          },
        ],
      }),
      entries = [rest("2026-10-09"), entry];
    const lunch = base("lunch", "Prepare lunch", { minutes: 20 }),
      packing = base("packing", "Pack work bag", { minutes: 10 });
    const plan = planPreparation(entries, [packing, lunch], s, clock());
    const a = plan.rows.find((r) => r.taskId === "lunch")!,
      b = plan.rows.find((r) => r.taskId === "packing")!;
    expect(a.at).not.toBeNull();
    expect(b.at).not.toBeNull();
    expect(b.at!).toBeGreaterThanOrEqual(a.end!);
    expect(plan.shiftPlan).toEqual(
      planShift(entry, s, entries, [packing, lunch]),
    );
  });
  it("searches within an explicitly earlier deadline and respects the edited preferred window", () => {
    const entry = shift(),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const v = suggestPreparationTask(
      "Iron work clothes",
      entries,
      [],
      s,
      clock(),
      {
        deadline: "2026-10-09T10:00",
        windowStart: "09:00",
        windowEnd: "10:00",
      },
    )!;
    expect(v.earliest).toBe("2026-10-09T09:00");
    expect(v.deadline).toBe("2026-10-09T10:00");
    expect(v.conflict).toBeUndefined();
    const impossible = suggestPreparationTask(
      "Iron work clothes",
      entries,
      [],
      s,
      clock(),
      {
        minutes: 90,
        deadline: "2026-10-09T10:00",
        windowStart: "09:00",
        windowEnd: "10:00",
      },
    )!;
    expect(impossible.scheduledStart).toBeNull();
    expect(impossible.conflict).toBeTruthy();
  });
  it("flags bedtime-specific tasks that overlap recovery after an overnight duty or rest-day sleep", () => {
    const entry = shift(),
      s = settings(),
      overnight = {
        ...shift("Early", "2026-10-08"),
        category: "Night" as const,
        start: "2026-10-08T22:00",
        end: "2026-10-09T10:00",
      };
    const shower = base("shower", "Shower for bed", {
      earliest: "2026-10-09T19:00",
      scheduledStart: "2026-10-09T19:00",
      omittedFields: ["deadline", "windowStart", "windowEnd"],
    });
    const p = planPreparation(
      [overnight, rest("2026-10-09"), entry],
      [shower],
      s,
      clock("2026-10-09T11:00"),
    );
    expect(p.rows.find((r) => r.taskId === "shower")?.conflict).toContain(
      "post-duty recovery and full sleep target",
    );
    const restShower = {
      ...shower,
      earliest: "2026-10-09T03:00",
      scheduledStart: "2026-10-09T03:00",
    };
    expect(
      planPreparation(
        [rest("2026-10-09"), entry],
        [restShower],
        s,
        clock(),
      ).rows.find((r) => r.taskId === "shower")?.conflict,
    ).toContain("previous-day rest sleep");
  });
  it("reflows an automatic last meal when a shower is added later or its duration changes, preserving saved values", () => {
    const entry = shift("Late"),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const meal = suggested("Last meal before bed", entry, s).task;
    expect(meal.preparationAutoStart).toBe(true);
    expect(meal.scheduledStart).toBe("2026-10-09T22:00");
    const shower = suggested("Shower for bed", entry, s, [meal]).task;
    const saved = JSON.stringify([meal, shower]);
    const plan = planPreparation(entries, [meal, shower], s, clock());
    expect(
      localAt(plan.rows.find((r) => r.taskId === meal.id)!.at!, zone),
    ).toBe("2026-10-09T21:30");
    expect(
      localAt(plan.rows.find((r) => r.taskId === shower.id)!.at!, zone),
    ).toBe("2026-10-09T22:00");
    expect(plan.rows.filter((r) => r.taskId).every((r) => !r.conflict)).toBe(
      true,
    );
    const changed = planPreparation(
      entries,
      [meal, { ...shower, minutes: 45 }],
      s,
      clock(),
    );
    expect(
      localAt(changed.rows.find((r) => r.taskId === meal.id)!.at!, zone),
    ).toBe("2026-10-09T21:15");
    expect(
      localAt(changed.rows.find((r) => r.taskId === shower.id)!.at!, zone),
    ).toBe("2026-10-09T21:45");
    expect(JSON.stringify([meal, shower])).toBe(saved);
  });
  it("retains a deliberate manual meal start and a fixed appointment while flagging a new shower overlap", () => {
    const entry = shift("Late"),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const meal = suggested("Last meal before bed", entry, s, [], {
      earliest: "2026-10-09T22:00",
      scheduledStart: "2026-10-09T22:00",
    }).task;
    expect(meal.preparationAutoStart).toBe(false);
    const shower = suggested("Shower for bed", entry, s, [meal]).task;
    const appointment = base("booking", "Booked haircut", {
      kind: "fixed",
      movable: false,
      locked: true,
      earliest: "2026-10-09T11:00",
      scheduledStart: "2026-10-09T11:00",
      preparationAutoStart: true,
    });
    const before = JSON.stringify([meal, shower, appointment]),
      plan = planPreparation(entries, [meal, shower, appointment], s, clock());
    const row = plan.rows.find((r) => r.taskId === meal.id)!;
    expect(localAt(row.at!, zone)).toBe("2026-10-09T22:00");
    expect(row.conflict).toContain("Shower for bed");
    expect(
      localAt(plan.rows.find((r) => r.taskId === "booking")!.at!, zone),
    ).toBe("2026-10-09T11:00");
    expect(JSON.stringify([meal, shower, appointment])).toBe(before);
  });
  it("keeps explicit automatic-task deadline/window limits and validates each bedtime window endpoint independently", () => {
    const entry = shift("Late"),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const meal = suggested("Last meal before bed", entry, s, [], {
      deadline: "2026-10-09T20:00",
      windowStart: "18:00",
      windowEnd: "20:00",
      minutes: 40,
    }).task;
    const plan = planPreparation(entries, [meal], s, clock());
    expect(
      localAt(plan.rows.find((r) => r.taskId === meal.id)!.at!, zone),
    ).toBe("2026-10-09T19:20");
    const wind = base("wind", "Wind down", {
      minutes: 60,
      earliest: "2026-10-09T22:30",
      scheduledStart: "2026-10-09T22:30",
      windowStart: "23:00",
      omittedFields: ["windowEnd", "deadline"],
    });
    const p = planPreparation(entries, [wind], s, clock());
    expect(p.rows.find((r) => r.taskId === "wind")?.conflict).toContain(
      "outside the preferred window",
    );
    const endOnly = {
      ...wind,
      windowStart: "00:00",
      windowEnd: "22:00",
      omittedFields: ["windowStart", "deadline"] as Task["omittedFields"],
    };
    expect(
      planPreparation(entries, [endOnly], s, clock()).rows.find(
        (r) => r.taskId === "wind",
      )?.conflict,
    ).toContain("outside the preferred window");
  });
  it("keeps a 90-minute automatic wind-down ending at bedtime and does not offer a past shower slot", () => {
    const entry = shift(),
      s = settings(),
      entries = [rest("2026-10-09"), entry];
    const wind = suggested("Wind down", entry, s, [], { minutes: 90 }).task;
    const p = planPreparation(entries, [wind], s, clock());
    const row = p.rows.find((r) => r.taskId === wind.id)!;
    expect(localAt(row.at!, zone)).toBe("2026-10-09T19:00");
    expect(localAt(row.end!, zone)).toBe("2026-10-09T20:30");
    expect(row.conflict).toBeUndefined();
    const now = clock("2026-10-09T19:15"),
      shower = suggested("Shower for bed", entry, s).task;
    const after = planPreparation(entries, [shower], s, now).rows.find(
      (r) => r.taskId === shower.id,
    )!;
    expect(after.at).toBeNull();
    expect(after.conflict).toContain("No permitted");
    const newSuggestion = suggestPreparationTask(
      "Shower for bed",
      entries,
      [],
      s,
      now,
    )!;
    expect(newSuggestion.earliest).toBe("");
    expect(newSuggestion.scheduledStart).toBeNull();
    expect(newSuggestion.conflict).toContain("No permitted");
    expect(
      planPreparation(entries, [wind], s, clock("2026-10-09T19:30")).rows.find(
        (r) => r.taskId === wind.id,
      )?.conflict,
    ).toContain("start has passed");
  });
  it.each([
    { kind: "fixed" as const, locked: false, movable: true },
    { kind: "essential" as const, locked: true, movable: true },
    { kind: "flexible" as const, locked: false, movable: false },
    {
      kind: "essential" as const,
      locked: false,
      movable: true,
      preparationAutoStart: false,
    },
  ])(
    "retains the chosen 16:30 appointment when departure inputs are missing (%j)",
    (patch) => {
      const entry = shift("Late"),
        s = settings({ outboundMax: null }),
        entries = [rest("2026-10-09"), entry];
      const booking = base("booking", "Booked haircut", {
        ...patch,
        earliest: "2026-10-09T16:30",
        scheduledStart: "2026-10-09T16:30",
        minutes: 30,
        linkedShiftId: entry.id,
      });
      const saved = JSON.stringify(booking),
        p = planPreparation(entries, [booking], s, clock()),
        row = p.rows.find((r) => r.taskId === "booking")!,
        placement = p.placements.find((p) => p.taskId === "booking")!;
      expect(localAt(row.at!, zone)).toBe("2026-10-09T16:30");
      expect(localAt(row.end!, zone)).toBe("2026-10-09T17:00");
      expect(row.status).toBe("conflict");
      expect(row.conflict).toContain(
        "Departure inputs for the linked duty are missing",
      );
      expect(placement.conflict).toBe(row.conflict);
      expect(JSON.stringify(booking)).toBe(saved);
      expect(p.shiftPlan).toEqual(planShift(entry, s, entries, [booking]));
      const automatic = {
        ...booking,
        kind: "essential" as const,
        locked: false,
        movable: true,
        preparationAutoStart: true,
      };
      expect(
        planPreparation(entries, [automatic], s, clock()).rows.find(
          (r) => r.taskId === "booking",
        )?.at,
      ).toBeNull();
    },
  );
  it("makes invalid prior Work and mixed-timezone uncertainty visible on tasks, generated stages and suggestions", () => {
    const entry = shift(),
      s = settings(),
      invalid = { ...shift("Early", "2026-10-09"), end: "2026-10-09T99:00" };
    const shower = base("shower", "Shower for bed", {
      scheduledStart: "2026-10-09T19:00",
      earliest: "2026-10-09T19:00",
    });
    const plan = planPreparation(
      [invalid, entry],
      [shower],
      s,
      clock("2026-10-09T12:00"),
    );
    expect(plan.rows.find((r) => r.taskId === "shower")?.conflict).toContain(
      "invalid work start or finish",
    );
    expect(plan.rows.find((r) => r.kind === "windDown")?.conflict).toContain(
      "invalid work start or finish",
    );
    const la = { ...entry, timezone: "America/Los_Angeles" },
      laRest = { ...rest("2026-10-09"), timezone: "America/Los_Angeles" };
    const suggestion = suggestPreparationTask(
      "Shower for bed",
      [laRest, la],
      [],
      s,
      clock(),
    )!;
    expect(suggestion.conflict).toContain("America/Los_Angeles");
    expect(suggestion.conflict).toContain("Europe/London");
    const mixed = planPreparation([laRest, la], [], s, clock());
    expect(mixed.preparationDate).toBe("2026-10-09");
    expect(mixed.rows.find((r) => r.kind === "windDown")?.conflict).toContain(
      "timezones",
    );
  });
});
