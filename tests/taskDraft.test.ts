import { describe, expect, it } from "vitest";
import type { Task } from "../src/model";
import { zonedEpoch } from "../src/engine/time";
import {
  applyTaskSuggestion,
  snapshotTaskPlacement,
  taskForEditing,
  taskForSaving,
  taskSuggestionOverrides,
  taskTimeProvenance,
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
