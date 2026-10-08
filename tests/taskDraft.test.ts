import { describe, expect, it } from "vitest";
import type { Task } from "../src/model";
import { zonedEpoch } from "../src/engine/time";
import { newSettings } from "../src/data/defaults";
import { suggestPreparationTask } from "../src/engine/taskSuggestions";
import type { RotaEntry, Settings } from "../src/model";
import {
  applyTaskSuggestion,
  resolveTaskDraftSuggestion,
  snapshotTaskPlacement,
  taskForEditing,
  taskForSaving,
  taskSuggestionOverrides,
  taskTimeProvenance,
  taskDraftTiming,
  taskDraftStartValue,
  withOptionalTaskField,
} from "../src/ui/taskDraft";

const task = (patch: Partial<Task> = {}): Task => ({
  id: "preparation-draft",
  title: "Shower for bed",
  kind: "essential",
  minutes: 30,
  earliest: "2026-10-09T20:00",
  scheduledStart: "2026-10-09T20:00",
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
  linkedShiftId: "late-10th",
  omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
  ...patch,
});

describe("editable task suggestions", () => {
  it("persists automatic timing until the person deliberately chooses a date or time", () => {
    const suggestion = {
      minutes: 30,
      earliest: "2026-10-09T19:00",
      scheduledStart: "2026-10-09T19:00",
      deadline: "",
      windowStart: "",
      windowEnd: "",
      linkedShiftId: "late-10th",
    };
    const automatic = applyTaskSuggestion(task(), suggestion, new Set());
    const saved = taskForSaving(automatic, "Europe/London");
    expect(saved.preparationAutoStart).toBe(true);
    const reopened = taskForEditing(saved, "2026-10-09T18:30");
    expect(reopened.earliest).toBe("2026-10-09T18:30");
    expect(reopened.scheduledStart).toBe("2026-10-09T18:30");
    expect(reopened.preparationAutoStart).toBe(true);
    const chosen = taskTimeProvenance(
      {
        ...reopened,
        earliest: "2026-10-09T17:17",
        scheduledStart: "2026-10-09T17:17",
      },
      true,
    );
    expect(taskForSaving(chosen, "Europe/London").preparationAutoStart).toBe(
      false,
    );
    const laterSuggestion = applyTaskSuggestion(
      chosen,
      suggestion,
      new Set(["earliest", "scheduledStart"]),
    );
    expect(laterSuggestion.scheduledStart).toBe("2026-10-09T17:17");
    expect(laterSuggestion.preparationAutoStart).toBe(false);
  });

  it("preserves older manual saved times whose provenance is undefined", () => {
    const older = taskForSaving(task(), "Europe/London");
    expect(older.preparationAutoStart).toBeUndefined();
    const reopened = taskForEditing(older, "2026-10-09T18:30");
    expect(reopened.earliest).toBe(older.earliest);
    expect(reopened.scheduledStart).toBe(older.scheduledStart);
    expect(taskForSaving(reopened, "Europe/London")).toEqual(older);
  });

  it.each([{ kind: "fixed" as const }, { locked: true }, { movable: false }])(
    "never moves a fixed or locked saved appointment %s",
    (patch) => {
      const fixed = task({ preparationAutoStart: true, ...patch });
      const reopened = taskForEditing(fixed, "2026-10-09T18:30");
      expect(reopened.scheduledStart).toBe("2026-10-09T20:00");
      expect(
        taskForSaving(reopened, "Europe/London").preparationAutoStart,
      ).toBe(false);
    },
  );

  it("updates an untouched suggested start while preserving deliberately changed values", () => {
    const edited = new Set<keyof Task>([
      "minutes",
      "deadline",
      "windowStart",
      "location",
    ]);
    const draft = task({ minutes: 45, deadline: "", windowStart: "18:00" });
    const next = applyTaskSuggestion(
      draft,
      {
        minutes: 30,
        earliest: "2026-10-09T19:15",
        scheduledStart: "2026-10-09T19:15",
        deadline: "2026-10-09T20:00",
        windowStart: "09:00",
        windowEnd: "",
        linkedShiftId: "late-10th",
      },
      edited,
    );
    expect(next.minutes).toBe(45);
    expect(next.earliest).toBe("2026-10-09T19:15");
    expect(next.scheduledStart).toBe("2026-10-09T19:15");
    expect(next.deadline).toBe("");
    expect(next.windowStart).toBe("18:00");
    expect(next.location).toBe("");
    expect(taskSuggestionOverrides(next, edited)).toEqual({
      minutes: 45,
      deadline: "",
      windowStart: "18:00",
      location: "",
    });
    expect(draft.earliest).toBe("2026-10-09T20:00");
  });

  it("keeps a person's explicit date and time when they subsequently change the recognised title", () => {
    const draft = task({
      title: "Iron work clothes",
      earliest: "2026-10-09T17:17",
      scheduledStart: "2026-10-09T17:17",
    });
    const result = applyTaskSuggestion(
      draft,
      {
        minutes: 20,
        earliest: "2026-10-09T18:00",
        scheduledStart: "2026-10-09T18:00",
        deadline: "",
        windowStart: "",
        windowEnd: "",
        linkedShiftId: "late-10th",
      },
      new Set(["title", "earliest", "scheduledStart"]),
    );
    expect(result.title).toBe("Iron work clothes");
    expect(result.minutes).toBe(20);
    expect(result.earliest).toBe("2026-10-09T17:17");
    expect(result.scheduledStart).toBe("2026-10-09T17:17");
  });
});

describe("optional task fields and saved appointments", () => {
  it("saves an otherwise complete preparation task without requiring irrelevant appointment fields", () => {
    const saved = taskForSaving(task(), "Europe/London");
    expect(saved.deadline).toBe("2026-10-10T00:00");
    expect(saved.windowStart).toBe("00:00");
    expect(saved.windowEnd).toBe("00:00");
    expect(saved.location).toBe("");
    expect(saved.travelMinutes).toBe(0);
    expect(saved.scheduledStart).toBe("2026-10-09T20:00");
    const reopened = taskForEditing(saved);
    expect(reopened.deadline).toBe("");
    expect(reopened.windowStart).toBe("");
    expect(reopened.windowEnd).toBe("");
    expect(reopened.omittedFields).toContain("travelMinutes");
    expect(taskForSaving(reopened, "Europe/London")).toEqual(saved);
  });

  it("retains explicit deadline, preferred window and zero travel choices on reopen", () => {
    const draft = task({
      deadline: "2026-10-09T22:00",
      windowStart: "18:00",
      windowEnd: "21:00",
      omittedFields: withOptionalTaskField(task(), "travelMinutes", false),
    });
    const saved = taskForSaving(draft, "Europe/London");
    expect(saved.omittedFields).toEqual([]);
    expect(taskForEditing(saved).deadline).toBe("2026-10-09T22:00");
    expect(taskForEditing(saved).windowStart).toBe("18:00");
    expect(taskForEditing(saved).windowEnd).toBe("21:00");
  });

  it("keeps an existing fixed booking time when its earliest bound is edited", () => {
    const saved = taskForSaving(
      task({
        title: "Booked haircut",
        kind: "fixed",
        earliest: "2026-10-09T12:00",
        scheduledStart: "2026-10-09T14:15",
      }),
      "Europe/London",
    );
    expect(saved.scheduledStart).toBe("2026-10-09T14:15");
    expect(saved.locked).toBe(true);
    expect(saved.movable).toBe(false);
  });

  it("does not derive a hidden deadline before the end of an explicitly entered late appointment", () => {
    const saved = taskForSaving(
      task({
        earliest: "2026-10-09T23:50",
        scheduledStart: "2026-10-09T23:50",
        minutes: 30,
      }),
      "Europe/London",
    );
    expect(saved.deadline).toBe("2026-10-10T00:20");
  });

  it("does not give a fixed booking a false deadline conflict when its earliest bound is on an earlier date", () => {
    const saved = taskForSaving(
      task({
        kind: "fixed",
        earliest: "2026-10-09T12:00",
        scheduledStart: "2026-10-10T23:50",
        minutes: 30,
      }),
      "Europe/London",
    );
    expect(saved.scheduledStart).toBe("2026-10-10T23:50");
    expect(saved.deadline).toBe("2026-10-11T00:20");
  });

  it.each([
    [{ title: "" }, /name/],
    [{ minutes: 0 }, /positive duration/],
    [{ minutes: 1441 }, /1–1440/],
    [{ travelMinutes: 1441 }, /0–1440/],
    [{ travelMinutes: NaN }, /positive duration/],
    [{ earliest: "", scheduledStart: null }, /start date and time/],
    [{ deadline: "2026-10-09T19:00" }, /Deadline/],
    [{ windowStart: "24:00" }, /preferred window/],
  ] as const)("rejects invalid explicit values %s", (patch, error) => {
    expect(() => taskForSaving(task(patch), "Europe/London")).toThrow(error);
  });
});

describe("completed automatic preparation times", () => {
  const placement = {
    taskId: "preparation-draft",
    start: zonedEpoch("2026-10-09T18:30", "Europe/London"),
    end: zonedEpoch("2026-10-09T19:00", "Europe/London"),
    reason: "Calculated day-before slot",
  };

  it("freezes a one-off task's latest displayed slot before marking it completed or skipped", () => {
    const original = task({ preparationAutoStart: true });
    const snapshot = snapshotTaskPlacement(
      original,
      placement,
      "Europe/London",
    );
    expect(snapshot.earliest).toBe("2026-10-09T18:30");
    expect(snapshot.scheduledStart).toBe("2026-10-09T18:30");
    expect(snapshot.preparationAutoStart).toBe(false);
    expect(original.scheduledStart).toBe("2026-10-09T20:00");
    expect(original.preparationAutoStart).toBe(true);
    expect(snapshot.id).toBe(original.id);
  });

  it("preserves a recurring series' original time and its individual occurrence states", () => {
    const recurring = task({
      preparationAutoStart: true,
      recurrence: "daily",
      occurrenceStates: { "2026-10-08": "completed" },
    });
    expect(
      snapshotTaskPlacement(
        recurring,
        { ...placement, occurrenceDate: "2026-10-09" },
        "Europe/London",
      ),
    ).toBe(recurring);
    expect(recurring.occurrenceStates).toEqual({
      "2026-10-08": "completed",
    });
  });

  it("keeps manually entered times and automatic tasks without a valid matching placement unchanged", () => {
    const manual = task();
    expect(snapshotTaskPlacement(manual, placement, "Europe/London")).toBe(
      manual,
    );
    const automatic = task({ preparationAutoStart: true });
    expect(snapshotTaskPlacement(automatic, undefined, "Europe/London")).toBe(
      automatic,
    );
    expect(
      snapshotTaskPlacement(
        automatic,
        { ...placement, start: null },
        "Europe/London",
      ),
    ).toBe(automatic);
    expect(
      snapshotTaskPlacement(
        automatic,
        { ...placement, taskId: "different-task" },
        "Europe/London",
      ),
    ).toBe(automatic);
  });
});

describe("typed names and task ideas share the preparation form defaults", () => {
  const settings: Settings = {
    ...newSettings(),
    timezone: "Europe/London",
    timezoneConfirmed: true,
    additionalPrepConfirmed: true,
    sleepTarget: 480,
    latency: 30,
    windDown: 60,
    earlyWake: "05:00",
    lateWake: "08:00",
    restWake: "07:00",
    restBed: "23:00",
    outboundMin: 15,
    outboundMax: 20,
    arrivalBuffer: 10,
    returnMinutes: 20,
    postWorkMinutes: 30,
    freeMinutes: 0,
    routines: [
      {
        id: "get-ready",
        name: "Get ready",
        minutes: 30,
        includes: [],
        essential: true,
      },
    ],
    origins: {
      timezone: "entered",
      sleepTarget: "entered",
      latency: "entered",
      windDown: "entered",
      outboundMin: "entered",
      outboundMax: "entered",
      arrivalBuffer: "entered",
      returnMinutes: "entered",
      postWorkMinutes: "entered",
      "get-ready": "entered",
    },
  };
  const clock = {
    now: () => zonedEpoch("2026-10-08T09:00", settings.timezone),
  };
  const shift = (start: string): RotaEntry => ({
    id: "selected-duty",
    date: "2026-10-10",
    status: "Work",
    category: start === "06:00" ? "Early" : "Late",
    duty: "Synthetic duty",
    start: `2026-10-10T${start}`,
    end: `2026-10-10T${start === "06:00" ? "14:00" : "22:26"}`,
    timezone: settings.timezone,
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
  });
  const rest: RotaEntry = {
    ...shift("06:00"),
    id: "preparation-rest",
    date: "2026-10-09",
    status: "Rest",
    start: null,
    end: null,
  };

  it.each(["14:08", "06:00"])(
    "applies the same shower defaults for a typed name or idea before a %s duty",
    (start) => {
      const selected = shift(start);
      const suggestion = suggestPreparationTask(
        "Shower for bed",
        [rest, selected],
        [],
        settings,
        clock,
        {},
        selected,
      );
      expect(suggestion).not.toBeNull();
      const typedBaseline = task({
        title: "",
        kind: "flexible",
        earliest: "2026-10-08T09:00",
        scheduledStart: null,
        linkedShiftId: undefined,
      });
      const ideaBaseline = task({
        title: "Shower for bed",
        earliest: "",
        scheduledStart: null,
        linkedShiftId: selected.id,
      });
      const typed = resolveTaskDraftSuggestion(
        { ...typedBaseline, title: "Shower for bed" },
        suggestion,
        new Set(["title"]),
        typedBaseline,
      );
      const idea = resolveTaskDraftSuggestion(
        ideaBaseline,
        suggestion,
        new Set(),
        ideaBaseline,
      );
      expect(typed.minutes).toBe(30);
      expect(typed.kind).toBe("essential");
      expect(typed.kind).toBe(idea.kind);
      expect(taskDraftTiming(typed, suggestion!.preparationDate)).toEqual(
        taskDraftTiming(idea, suggestion!.preparationDate),
      );
      expect(taskDraftTiming(typed, suggestion!.preparationDate).date).toBe(
        "2026-10-09",
      );
      expect(taskDraftTiming(typed, suggestion!.preparationDate).time).toMatch(
        /^\d{2}:\d{2}$/,
      );
      expect(typed.linkedShiftId).toBe(selected.id);
      expect(typed.deadline).toBe("");
      expect(typed.windowStart).toBe("");
      expect(typed.windowEnd).toBe("");
      expect(typed.location).toBe("");
    },
  );

  it("shows the known previous calendar date when missing wake settings prevent a safe clock", () => {
    const selected = shift("14:08");
    const suggestion = suggestPreparationTask(
      "Shower for bed",
      [rest, selected],
      [],
      { ...settings, lateWake: null, restWake: null },
      clock,
      {},
      selected,
    )!;
    expect(suggestion.minutes).toBe(30);
    expect(suggestion.preparationDate).toBe("2026-10-09");
    expect(suggestion.scheduledStart).toBeNull();
    const baseline = task({ earliest: "", scheduledStart: null });
    const draft = resolveTaskDraftSuggestion(
      baseline,
      suggestion,
      new Set(),
      baseline,
    );
    expect(taskDraftTiming(draft, suggestion.preparationDate)).toEqual({
      date: "2026-10-09",
      time: "",
    });
    expect(draft.earliest).toBe("");
    expect(() => taskForSaving(draft, settings.timezone)).toThrow(
      /start date and time/,
    );
  });

  it("revokes unconfirmed task-specific values when a global title stops being recognised", () => {
    const baseline = task({
      title: "",
      kind: "flexible",
      minutes: 30,
      earliest: "2026-10-08T09:00",
      scheduledStart: null,
      linkedShiftId: undefined,
    });
    const oldSuggestion = task({ minutes: 45, preparationAutoStart: true });
    const revoked = resolveTaskDraftSuggestion(
      { ...oldSuggestion, title: "Something else" },
      null,
      new Set(["title"]),
      baseline,
    );
    expect(revoked.title).toBe("Something else");
    expect(revoked.kind).toBe("flexible");
    expect(revoked.minutes).toBe(30);
    expect(revoked.earliest).toBe(baseline.earliest);
    expect(revoked.scheduledStart).toBeNull();
    expect(revoked.linkedShiftId).toBeUndefined();
    const deliberatelyEdited = resolveTaskDraftSuggestion(
      { ...oldSuggestion, title: "", minutes: 55 },
      null,
      new Set(["title", "minutes", "earliest", "scheduledStart"]),
      baseline,
    );
    expect(deliberatelyEdited.minutes).toBe(55);
    expect(deliberatelyEdited.earliest).toBe(oldSuggestion.earliest);
    expect(deliberatelyEdited.scheduledStart).toBe(
      oldSuggestion.scheduledStart,
    );
  });

  it("displays the scheduled start rather than a broader earliest bound", () => {
    expect(
      taskDraftTiming(
        task({
          earliest: "2026-10-09T12:00",
          scheduledStart: "2026-10-09T18:30",
        }),
      ),
    ).toEqual({ date: "2026-10-09", time: "18:30" });
  });

  it("preserves a deliberately chosen task kind when applying task-specific defaults", () => {
    const baseline = task({ kind: "flexible" });
    const result = resolveTaskDraftSuggestion(
      task({ kind: "fixed", locked: true, movable: false }),
      { ...task(), kind: "essential", preparationDate: "2026-10-09" },
      new Set(["kind", "locked", "movable"]),
      baseline,
    );
    expect(result.kind).toBe("fixed");
    expect(result.locked).toBe(true);
    expect(result.movable).toBe(false);
    expect(result.preparationAutoStart).toBe(false);
  });

  it("keeps the preparation date in the selected shift timezone while persisting the same instant in settings timezone", () => {
    const stored = task({
      earliest: "2026-10-10T06:30",
      scheduledStart: "2026-10-10T06:30",
    });
    expect(
      taskDraftTiming(stored, "2026-10-09", "Asia/Tokyo", "Europe/London"),
    ).toEqual({ date: "2026-10-09", time: "22:30" });
    expect(
      taskDraftStartValue("2026-10-09", "22:30", "Europe/London", "Asia/Tokyo"),
    ).toBe(stored.scheduledStart);
    expect(() =>
      taskDraftStartValue("2026-03-29", "01:30", "Europe/London", "Asia/Tokyo"),
    ).toThrow();
  });
});
