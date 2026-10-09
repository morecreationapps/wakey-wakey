import { describe, expect, it } from "vitest";
import { newSettings } from "../src/data/defaults";
import { planPreparation } from "../src/engine/preparation";
import { suggestPreparationTask } from "../src/engine/taskSuggestions";
import { localAt, zonedEpoch } from "../src/engine/time";
import type { Clock, RotaEntry, Settings, Task } from "../src/model";
import {
  applyTaskSuggestion,
  taskForSaving,
  taskSuggestionOverrides,
  taskTimeProvenance,
} from "../src/ui/taskDraft";

const zone = "Europe/London";
const clock: Clock = { now: () => zonedEpoch("2026-10-08T09:00", zone) };
const settings: Settings = {
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
  earlyWake: "05:00",
  lateWake: "07:00",
  lateBed: "00:30",
  restWake: "07:00",
  restBed: "23:30",
  beforeEarlyBed: "21:30",
  beforeEarlyWake: "05:00",
  beforeLateBed: "23:30",
  beforeLateWake: "07:00",
  freeMinutes: 0,
  routines: [
    {
      id: "morning",
      name: "Prepare for work",
      minutes: 30,
      essential: true,
      includes: ["shower"],
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
    ].map((key) => [key, "entered"]),
  ),
};
const shift = (category: "Early" | "Late"): RotaEntry => ({
  id: `${category}-10th`,
  date: "2026-10-10",
  status: "Work",
  category,
  duty: category === "Early" ? "24E" : "24L",
  start: `2026-10-10T${category === "Early" ? "06:00" : "14:08"}`,
  end: `2026-10-10T${category === "Early" ? "14:18" : "22:26"}`,
  timezone: zone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  paidMinutes: null,
  breakMinutes: null,
});
const entriesFor = (selected: RotaEntry): RotaEntry[] => [
  {
    ...selected,
    id: "rest-9th",
    date: "2026-10-09",
    status: "Rest",
    start: null,
    end: null,
  },
  selected,
];
const draft = (title: string): Task => ({
  id: `task-${title}`,
  title,
  kind: "essential",
  minutes: 30,
  earliest: "",
  scheduledStart: null,
  deadline: "",
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
});

describe("task entry dates for the selected shift's two panels", () => {
  it.each([
    ["Early", "20:00", "21:30"],
    ["Late", "22:00", "23:30"],
  ] as const)(
    "uses previous-calendar-day suggestions for %s typed names and ideas without duplicate saves",
    (category, showerTime, bedtime) => {
      const selected = shift(category),
        entries = entriesFor(selected);
      for (const [title, expected] of [
        ["Shower for bed", showerTime],
        ["Go to sleep", bedtime],
      ]) {
        const suggestion = suggestPreparationTask(
          title,
          entries,
          [],
          settings,
          clock,
          {},
          selected,
        )!;
        const typed = applyTaskSuggestion(draft(title), suggestion, new Set());
        const idea = applyTaskSuggestion(
          draft(title),
          suggestion,
          new Set(["title"]),
        );
        expect(typed).toEqual(idea);
        expect(typed.scheduledStart).toBe(`2026-10-09T${expected}`);
        expect([
          typed.deadline,
          typed.windowStart,
          typed.windowEnd,
          typed.location,
        ]).toEqual(["", "", "", ""]);
        const saved = taskForSaving(typed, zone);
        const plan = planPreparation(entries, [saved, saved], settings, clock, {
          selectedShift: selected,
        });
        expect(plan.rows.filter((row) => row.taskId === saved.id)).toHaveLength(
          1,
        );
        expect(
          localAt(plan.rows.find((row) => row.taskId === saved.id)!.at!, zone),
        ).toBe(`2026-10-09T${expected}`);
      }
    },
  );

  it.each(["Iron work clothes", "Shower for bed"])(
    "retains a manually chosen shift-day %s time without applying the previous day's deadline",
    (title) => {
      const selected = shift("Late"),
        entries = entriesFor(selected);
      const initial = suggestPreparationTask(
        title,
        entries,
        [],
        settings,
        clock,
        {},
        selected,
      )!;
      const chosen = taskTimeProvenance(
        {
          ...applyTaskSuggestion(draft(title), initial, new Set()),
          earliest: "2026-10-10T11:00",
          scheduledStart: "2026-10-10T11:00",
        },
        true,
      );
      const edited = new Set<keyof Task>(["earliest", "scheduledStart"]);
      const nextSuggestion = suggestPreparationTask(
        title,
        entries,
        [],
        settings,
        clock,
        taskSuggestionOverrides(chosen, edited),
        selected,
      )!;
      const saved = taskForSaving(
        applyTaskSuggestion(chosen, nextSuggestion, edited),
        zone,
      );
      expect(saved.preparationAutoStart).toBe(false);
      expect(saved.scheduledStart).toBe("2026-10-10T11:00");
      const plan = planPreparation(entries, [saved], settings, clock, {
        selectedShift: selected,
      });
      const row = plan.rows.find((row) => row.taskId === saved.id)!;
      expect(row.at).toBe(zonedEpoch("2026-10-10T11:00", zone));
      expect(row.conflict).toBeUndefined();
      expect(nextSuggestion.conflict).toBeUndefined();
      expect(nextSuggestion.explanation).toContain("chosen date and time");
    },
  );

  it.each(["Early", "Late"] as const)(
    "retains fixed shift-day times and actual conflicts without a false previous-day date warning for %s",
    (category) => {
      const selected = shift(category),
        entries = entriesFor(selected);
      const fixed = taskForSaving(
        {
          ...draft("Haircut"),
          kind: "fixed",
          linkedShiftId: selected.id,
          earliest: "2026-10-10T11:00",
          scheduledStart: "2026-10-10T11:00",
        },
        zone,
      );
      const before = JSON.stringify(fixed);
      const plan = planPreparation(entries, [fixed], settings, clock, {
        selectedShift: selected,
      });
      const rows = plan.rows.filter((row) => row.taskId === fixed.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].at).toBe(zonedEpoch("2026-10-10T11:00", zone));
      expect(rows[0].conflict ?? "").not.toContain("calendar day before");
      if (category === "Early") expect(rows[0].conflict).toContain("work");
      else expect(rows[0].conflict).toBeUndefined();
      expect(JSON.stringify(fixed)).toBe(before);
    },
  );

  it("retains separate previous-day and shift-day occurrences of the same fixed task", () => {
    const selected = shift("Late"),
      entries = entriesFor(selected);
    const recurring = taskForSaving(
      {
        ...draft("Appointment"),
        kind: "fixed",
        linkedShiftId: selected.id,
        earliest: "2026-10-09T11:00",
        scheduledStart: "2026-10-09T11:00",
        deadline: "2026-10-10T12:00",
        recurrence: "daily",
      },
      zone,
    );
    const plan = planPreparation(entries, [recurring], settings, clock, {
      selectedShift: selected,
    });
    const occurrences = plan.placements.filter(
      (placement) => placement.taskId === recurring.id,
    );
    expect(
      occurrences.map((placement) => placement.occurrenceDate).sort(),
    ).toEqual(["2026-10-09", "2026-10-10"]);
    expect(
      occurrences.map((placement) => localAt(placement.start!, zone)).sort(),
    ).toEqual(["2026-10-09T11:00", "2026-10-10T11:00"]);
  });

  it("keeps an explicit date editable while an incomplete duration is being corrected", () => {
    const selected = shift("Late");
    const suggestion = suggestPreparationTask(
      "Iron work clothes",
      entriesFor(selected),
      [],
      settings,
      clock,
      {
        earliest: "2026-10-10T11:00",
        scheduledStart: "2026-10-10T11:00",
        minutes: Number.NaN,
      },
      selected,
    )!;
    expect(suggestion.scheduledStart).toBe("2026-10-10T11:00");
    expect(suggestion.conflict).toContain("Enter a positive duration");
  });

  it.each([
    ["04:00", "sleep"],
    ["13:30", "work and travel"],
    ["11:00", "fixed commitment: Haircut"],
  ] as const)(
    "keeps the chosen shift-day shower at %s and flags the actual %s conflict",
    (time, reason) => {
      const selected = shift("Late"),
        entries = entriesFor(selected);
      const shower = taskForSaving(
        {
          ...draft("Shower for bed"),
          linkedShiftId: selected.id,
          preparationAutoStart: false,
          earliest: `2026-10-10T${time}`,
          scheduledStart: `2026-10-10T${time}`,
        },
        zone,
      );
      const appointment = taskForSaving(
        {
          ...draft("Haircut"),
          kind: "fixed",
          earliest: "2026-10-10T11:00",
          scheduledStart: "2026-10-10T11:00",
        },
        zone,
      );
      const plan = planPreparation(
        entries,
        [shower, appointment],
        settings,
        clock,
        { selectedShift: selected },
      );
      const row = plan.rows.find((row) => row.taskId === shower.id)!;
      expect(localAt(row.at!, zone)).toBe(`2026-10-10T${time}`);
      expect(row.conflict).toContain(reason);
      expect(row.conflict).not.toContain("calendar day before");
    },
  );
});
