import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { RotaEntry, Settings, Task } from "../src/model";
import { panelCalendarDate, panelRollover } from "../src/engine/panelRollover";
import { planPreparation } from "../src/engine/preparation";
import { planShift } from "../src/engine/planner";
import { suggestPreparationTask } from "../src/engine/taskSuggestions";
import { shiftDayPanels } from "../src/engine/shiftDayPanels";
import {
  resolveTaskDraftSuggestion,
  taskForEditing,
  taskForSaving,
  taskSuggestionOverrides,
  type TaskDraftField,
} from "../src/ui/taskDraft";
import { addDays, localAt, zonedEpoch } from "../src/engine/time";

const zone = "Europe/London";
const clock = (local: string, timezone = zone) => ({
  now: () => zonedEpoch(local, timezone),
});
const work = (
  date: string,
  category: "Early" | "Late" = "Late",
  patch: Partial<RotaEntry> = {},
): RotaEntry => ({
  id: `work-${date}`,
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
const day = (
  date: string,
  status: RotaEntry["status"] = "Rest",
): RotaEntry => ({
  ...work(date),
  id: `${status}-${date}`,
  status,
  start: null,
  end: null,
});
const rota = () => [
  work("2026-10-10"),
  work("2026-10-11"),
  work("2026-10-12"),
  day("2026-10-13"),
  day("2026-10-14"),
  work("2026-10-15", "Early"),
  work("2026-10-16", "Early"),
];
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
  caffeine: true,
  caffeineBeforeBed: 360,
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

describe("calendar rollover and independent panel references", () => {
  it("replaces Friday's preparation with Wednesday's next-block preparation on Saturday", () => {
    const entries = rota(),
      original = structuredClone(entries),
      selected = panelRollover(entries, settings(), clock("2026-10-10T09:00"));
    expect(selected.date).toBe("2026-10-10");
    expect(selected.shiftPlanShift?.id).toBe("work-2026-10-10");
    expect(selected.transitionShift?.id).toBe("work-2026-10-15");
    expect(addDays(selected.transitionShift!.date, -1)).toBe("2026-10-14");
    expect(entries).toEqual(original);
  });

  it.each(["09:00", "14:08", "18:00", "22:26", "23:59"])(
    "retains Saturday's Shift Plan throughout its shift day at %s",
    (time) => {
      expect(
        panelRollover(rota(), settings(), clock(`2026-10-10T${time}`))
          .shiftPlanShift?.date,
      ).toBe("2026-10-10");
    },
  );

  it("advances at 00:01, retaining the preceding date only for the requested first minute", () => {
    const before = panelRollover(rota(), settings(), clock("2026-10-10T23:59")),
      midnight = panelRollover(rota(), settings(), clock("2026-10-11T00:00")),
      after = panelRollover(rota(), settings(), clock("2026-10-11T00:01"));
    expect(before.shiftPlanShift?.date).toBe("2026-10-10");
    expect(midnight.date).toBe("2026-10-10");
    expect(midnight.shiftPlanShift?.date).toBe("2026-10-10");
    expect(after.date).toBe("2026-10-11");
    expect(after.shiftPlanShift?.date).toBe("2026-10-11");
    expect(midnight.nextRolloverAt).toBe(clock("2026-10-11T00:01").now());
    expect(after.nextRolloverAt).toBe(clock("2026-10-12T00:01").now());
  });

  it("advances the transition when the next block begins, without leaving stale preparation", () => {
    const entries = [
      ...rota(),
      work("2026-10-17", "Early"),
      day("2026-10-18"),
      work("2026-10-19", "Late"),
    ];
    expect(
      panelRollover(entries, settings(), clock("2026-10-14T23:59"))
        .transitionShift?.date,
    ).toBe("2026-10-15");
    expect(
      panelRollover(entries, settings(), clock("2026-10-15T00:00"))
        .transitionShift?.date,
    ).toBe("2026-10-15");
    expect(
      panelRollover(entries, settings(), clock("2026-10-15T00:01"))
        .transitionShift?.date,
    ).toBe("2026-10-19");
  });

  it("shows the next recorded duty on rest days and leaves transition empty without a future block", () => {
    const selected = panelRollover(
      rota(),
      settings(),
      clock("2026-10-14T09:00"),
    );
    expect(selected.shiftPlanShift?.date).toBe("2026-10-15");
    expect(selected.transitionShift?.date).toBe("2026-10-15");
    const noFutureBlock = panelRollover(
      rota(),
      settings(),
      clock("2026-10-15T09:00"),
    );
    expect(noFutureBlock.shiftPlanShift?.date).toBe("2026-10-15");
    expect(noFutureBlock.transitionShift).toBeUndefined();
    const noFutureWork = panelRollover(
      rota(),
      settings(),
      clock("2026-10-17T09:00"),
    );
    expect(noFutureWork.shiftPlanShift).toBeUndefined();
    expect(noFutureWork.transitionShift).toBeUndefined();
  });

  it("finds category changes on consecutive days and gaps before same-category blocks", () => {
    const entries = [
      work("2026-10-10"),
      work("2026-10-11", "Early"),
      work("2026-10-12", "Early"),
      work("2026-10-15", "Early"),
    ];
    expect(
      panelRollover(entries, settings(), clock("2026-10-10T09:00"))
        .transitionShift?.date,
    ).toBe("2026-10-11");
    expect(
      panelRollover(entries, settings(), clock("2026-10-11T09:00"))
        .transitionShift?.date,
    ).toBe("2026-10-15");
  });

  it("selects the same earliest duty regardless of input order, including multiple duties per day", () => {
    const first = work("2026-10-10", "Early", { id: "first" }),
      second = work("2026-10-10", "Late", { id: "second" }),
      entries = [second, work("2026-10-11", "Late"), first];
    expect(
      panelRollover(entries, settings(), clock("2026-10-10T18:00"))
        .shiftPlanShift?.id,
    ).toBe("first");
    expect(
      panelRollover(
        [...entries].reverse(),
        settings(),
        clock("2026-10-10T18:00"),
      ).shiftPlanShift?.id,
    ).toBe("first");
  });

  it("uses an overnight duty's starting calendar date and advances on the next 00:01", () => {
    const overnight = work("2026-10-10", "Late", {
        start: "2026-10-10T22:00",
        end: "2026-10-11T06:00",
      }),
      next = work("2026-10-11", "Late", {
        start: "2026-10-11T22:00",
        end: "2026-10-12T06:00",
      });
    expect(
      panelRollover([overnight, next], settings(), clock("2026-10-11T00:00"))
        .shiftPlanShift?.id,
    ).toBe(overnight.id);
    expect(
      panelRollover([overnight, next], settings(), clock("2026-10-11T00:01"))
        .shiftPlanShift?.id,
    ).toBe(next.id);
  });

  it.each(["2026-03-29", "2026-10-25"])(
    "uses local 00:01 and calendar dates across London DST on %s",
    (date) => {
      const beforeDate = addDays(date, -1),
        before = panelRollover([], settings(), clock(`${beforeDate}T23:59`)),
        midnight = panelRollover([], settings(), clock(`${date}T00:00`)),
        after = panelRollover([], settings(), clock(`${date}T00:01`));
      expect(midnight.date).toBe(beforeDate);
      expect(after.date).toBe(date);
      expect(localAt(before.nextRolloverAt, zone)).toBe(`${date}T00:01`);
      expect(localAt(after.nextRolloverAt, zone)).toBe(
        `${addDays(date, 1)}T00:01`,
      );
    },
  );

  it("ignores the device UTC date and uses the configured local timezone", () => {
    const c = { now: () => Date.parse("2026-10-10T23:01:00Z") };
    expect(panelCalendarDate(c, zone)).toBe("2026-10-11");
    expect(panelCalendarDate(c, "America/New_York")).toBe("2026-10-10");
  });

  it("resolves a midnight DST gap for display rollover while recorded local times remain strict", () => {
    const timezone = "America/Santiago",
      previousDate = "2026-09-05",
      newDate = "2026-09-06",
      midnightGap = `${newDate}T00:01`,
      before = panelRollover(
        [],
        { timezone },
        clock(`${previousDate}T23:59`, timezone),
      ),
      firstMinute = panelRollover(
        [],
        { timezone },
        clock(`${newDate}T01:00`, timezone),
      ),
      after = panelRollover(
        [],
        { timezone },
        clock(`${newDate}T01:01`, timezone),
      );
    expect(() => zonedEpoch(midnightGap, timezone)).toThrow();
    expect(localAt(before.nextRolloverAt, timezone)).toBe(`${newDate}T01:01`);
    expect(firstMinute.date).toBe(previousDate);
    expect(firstMinute.nextRolloverAt).toBe(before.nextRolloverAt);
    expect(after.date).toBe(newDate);
    expect(localAt(after.nextRolloverAt, timezone)).toBe("2026-09-07T00:01");
  });

  it("retains recorded invalid work for review without claiming an unknown gap is rest", () => {
    const entries = [
        work("2026-10-10", "Late", { start: null }),
        day("2026-10-11", "Unknown"),
        work("2026-10-12", "Early"),
      ],
      original = structuredClone(entries),
      selected = panelRollover(entries, settings(), clock("2026-10-10T09:00"));
    expect(selected.shiftPlanShift?.id).toBe("work-2026-10-10");
    expect(selected.transitionShift?.id).toBe("work-2026-10-12");
    expect(entries).toEqual(original);
    expect(entries[1].status).toBe("Unknown");
  });

  it("uses the canonical future preparation calculations for caffeine, wind-down and bedtime", () => {
    const entries = rota(),
      s = settings(),
      c = clock("2026-10-10T09:00"),
      selected = panelRollover(entries, s, c),
      future = planPreparation(entries, [], s, c, {
        selectedShift: selected.transitionShift,
      }),
      panels = shiftDayPanels(future, [], s);
    expect(panels.preparationDate).toBe("2026-10-14");
    for (const kind of ["caffeine", "windDown", "bedtime"]) {
      const row = panels.transitionRows.find((item) => item.kind === kind);
      expect(row).toBeDefined();
      expect(localAt(row!.at!, zone).slice(0, 10)).toBe("2026-10-14");
      expect(row!.at).toBe(
        future.shiftPlan!.events.find((event) => event.kind === kind)!.at,
      );
    }
  });

  it("clears stale displayed tasks without deleting them or changing the current-day Shift Plan calculations", () => {
    const entries = rota(),
      s = settings(),
      c = clock("2026-10-10T23:00"),
      saved: Task = {
        id: "previous-preparation",
        title: "Lay out clothes",
        kind: "essential",
        minutes: 10,
        earliest: "2026-10-09T00:00",
        deadline: "2026-10-09T23:59",
        scheduledStart: "2026-10-09T22:20",
        windowStart: "",
        windowEnd: "",
        priority: 1,
        recurrence: "none",
        location: "",
        travelMinutes: 0,
        movable: true,
        splittable: false,
        locked: false,
        state: "pending",
        linkedShiftId: "work-2026-10-10",
      },
      tasks = [saved],
      original = structuredClone(tasks),
      selected = panelRollover(entries, s, c),
      future = planPreparation(entries, tasks, s, c, {
        selectedShift: selected.transitionShift,
      }),
      current = planPreparation(entries, tasks, s, c, {
        selectedShift: selected.shiftPlanShift,
      });
    const transition = shiftDayPanels(future, tasks, s),
      shift = shiftDayPanels(current, tasks, s);
    expect(transition.preparationDate).toBe("2026-10-14");
    expect(
      transition.transitionRows.some((row) => row.taskId === saved.id),
    ).toBe(false);
    expect(tasks).toEqual(original);
    expect(current.shiftPlan).toEqual(
      planShift(selected.shiftPlanShift!, s, entries, tasks),
    );
    expect(shift.shiftDate).toBe("2026-10-10");
    expect(shift.shiftRows.find((row) => row.kind === "workStart")?.at).toBe(
      clock("2026-10-10T14:08").now(),
    );
  });

  it.each([
    ["Shower for bed", "20:00"],
    ["Go to sleep", "21:30"],
  ])(
    "suggests %s for Wednesday from the new Thursday reference, with optional fields blank",
    (title, time) => {
      const entries = rota(),
        s = settings(),
        c = clock("2026-10-10T09:00"),
        selected = panelRollover(entries, s, c),
        suggestion = suggestPreparationTask(
          title,
          entries,
          [],
          s,
          c,
          {},
          selected.transitionShift,
        )!;
      expect(suggestion.linkedShiftId).toBe("work-2026-10-15");
      expect(suggestion.preparationDate).toBe("2026-10-14");
      expect(suggestion.minutes).toBe(30);
      expect(suggestion.scheduledStart).toBe(`2026-10-14T${time}`);
      expect(suggestion.deadline).toBe("");
      expect(suggestion.windowStart).toBe("");
      expect(suggestion.windowEnd).toBe("");
      const baseline: Task = {
        id: `new-${title}`,
        title,
        kind: "flexible",
        minutes: 30,
        earliest: "",
        deadline: "",
        scheduledStart: null,
        windowStart: "",
        windowEnd: "",
        priority: 2,
        recurrence: "none",
        location: "",
        travelMinutes: 0,
        movable: true,
        splittable: false,
        locked: false,
        state: "pending",
        linkedShiftId: selected.transitionShift?.id,
        omittedFields: [
          "deadline",
          "windowStart",
          "windowEnd",
          "travelMinutes",
        ],
      };
      const suggestedDraft = resolveTaskDraftSuggestion(
        baseline,
        suggestion,
        new Set(),
        baseline,
      );
      expect(suggestedDraft.location).toBe("");
      const saved = taskForSaving(suggestedDraft, zone),
        tasks = [saved],
        preparation = planPreparation(entries, tasks, s, c, {
          selectedShift: selected.transitionShift,
        }),
        panels = shiftDayPanels(preparation, tasks, s);
      expect(
        panels.transitionRows.filter((row) => row.taskId === saved.id),
      ).toHaveLength(1);
      expect(panels.shiftRows.some((row) => row.taskId === saved.id)).toBe(
        false,
      );
      expect(
        localAt(
          panels.transitionRows.find((row) => row.taskId === saved.id)!.at!,
          zone,
        ),
      ).toBe(`2026-10-14T${time}`);
      expect(panels.transitionRows.map((row) => row.at)).toEqual(
        [...panels.transitionRows.map((row) => row.at)].sort((a, b) => a! - b!),
      );
      const reopened = taskForEditing(saved);
      expect(reopened.deadline).toBe("");
      expect(reopened.windowStart).toBe("");
      expect(reopened.windowEnd).toBe("");
      const edited = new Set<TaskDraftField>([
          "minutes",
          "earliest",
          "scheduledStart",
        ]),
        deliberate = {
          ...suggestedDraft,
          minutes: 45,
          earliest: "2026-10-14T19:30",
          scheduledStart: "2026-10-14T19:30",
        },
        revised = suggestPreparationTask(
          title,
          entries,
          [],
          s,
          c,
          taskSuggestionOverrides(deliberate, edited),
          selected.transitionShift,
        ),
        finalDraft = resolveTaskDraftSuggestion(
          deliberate,
          revised,
          edited,
          baseline,
        );
      expect(finalDraft.minutes).toBe(45);
      expect(finalDraft.earliest).toBe("2026-10-14T19:30");
      expect(finalDraft.scheduledStart).toBe("2026-10-14T19:30");
      expect(finalDraft.preparationAutoStart).toBe(false);
    },
  );

  it("updates the Shift Plan projection to Sunday at 00:01 with unchanged canonical calculations", () => {
    const entries = rota(),
      s = settings(),
      c = clock("2026-10-11T00:01"),
      selected = panelRollover(entries, s, c),
      preparation = planPreparation(entries, [], s, c, {
        selectedShift: selected.shiftPlanShift,
      }),
      panels = shiftDayPanels(preparation, [], s),
      canonical = planShift(selected.shiftPlanShift!, s, entries, []);
    expect(panels.shiftDate).toBe("2026-10-11");
    expect(preparation.shiftPlan).toEqual(canonical);
    for (const row of panels.shiftRows) {
      expect(localAt(row.at!, zone).slice(0, 10)).toBe("2026-10-11");
      expect(row.at).toBe(
        canonical.events.find((event) => event.kind === row.kind)!.at,
      );
    }
  });

  it("keeps an exhausted transition empty rather than falling back to the next consecutive work day", () => {
    const entries = rota(),
      s = settings(),
      c = clock("2026-10-15T09:00"),
      selected = panelRollover(entries, s, c);
    expect(selected.transitionShift).toBeUndefined();
    const preparation = planPreparation(entries, [], s, c, {
        selectedShift: selected.transitionShift ?? null,
      }),
      panels = shiftDayPanels(preparation, [], s);
    expect(preparation.nextShift).toBeUndefined();
    expect(preparation.preparationDate).toBeUndefined();
    expect(preparation.rows).toEqual([]);
    expect(panels.transitionRows).toEqual([]);
    expect(panels.preparationDate).toBeUndefined();
    expect(selected.shiftPlanShift?.date).toBe("2026-10-15");
  });
});
