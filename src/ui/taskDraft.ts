import { Temporal } from "@js-temporal/polyfill";
import type { Task } from "../model";
import type { TaskPlacement } from "../engine/planner";
import { localAt, zonedEpoch } from "../engine/time";

export type TaskDraftField = keyof Task;
export type PreparationSuggestionValues = Pick<
  Task,
  | "minutes"
  | "earliest"
  | "scheduledStart"
  | "deadline"
  | "windowStart"
  | "windowEnd"
  | "linkedShiftId"
> & { preparationDate?: string; kind?: Task["kind"] };

const suggestedFields: (keyof Task & keyof PreparationSuggestionValues)[] = [
  "kind",
  "minutes",
  "earliest",
  "scheduledStart",
  "deadline",
  "windowStart",
  "windowEnd",
  "linkedShiftId",
];

/** Suggestions only update fields that the person has not deliberately edited. */
export function applyTaskSuggestion(
  task: Task,
  suggestion: PreparationSuggestionValues,
  edited: ReadonlySet<TaskDraftField>,
): Task {
  const patch: Partial<Task> = {};
  for (const field of suggestedFields) {
    if (!edited.has(field) && suggestion[field] !== undefined)
      Object.assign(patch, { [field]: suggestion[field] });
  }
  const result = { ...task, ...patch };
  const explicitTime = edited.has("earliest") || edited.has("scheduledStart");
  const autoStart =
    !explicitTime &&
    result.preparationAutoStart !== false &&
    !!result.linkedShiftId &&
    !!result.scheduledStart;
  return taskTimeProvenance(
    autoStart ? { ...result, preparationAutoStart: true } : result,
    explicitTime,
  );
}

/** Idea buttons and typed names use the same reversible draft-only defaults. */
export function resolveTaskDraftSuggestion(
  task: Task,
  suggestion: PreparationSuggestionValues | null,
  edited: ReadonlySet<TaskDraftField>,
  baseline: Task,
): Task {
  if (suggestion) return applyTaskSuggestion(task, suggestion, edited);
  const patch: Partial<Task> = {};
  for (const field of suggestedFields) {
    if (!edited.has(field)) Object.assign(patch, { [field]: baseline[field] });
  }
  if (!edited.has("earliest") && !edited.has("scheduledStart"))
    patch.preparationAutoStart = baseline.preparationAutoStart;
  return taskTimeProvenance({ ...task, ...patch });
}

/** A known calendar date remains visible even when a safe clock is unavailable. */
export function taskDraftTiming(
  task: Task,
  preparationDate?: string,
  storageTimezone?: string,
  displayTimezone?: string,
): { date: string; time: string } {
  let start = task.scheduledStart || task.earliest;
  if (start && storageTimezone && displayTimezone) {
    try {
      start = localAt(zonedEpoch(start, storageTimezone), displayTimezone);
    } catch {
      // Incomplete draft values stay unchanged until the person chooses a time.
    }
  }
  return {
    date: start ? start.slice(0, 10) : preparationDate || "",
    time: start ? start.slice(11, 16) : "",
  };
}

/** Convert a picked preparation clock back to the app's canonical task timezone. */
export function taskDraftStartValue(
  date: string,
  time: string,
  displayTimezone: string,
  storageTimezone: string,
): string {
  return localAt(
    zonedEpoch(`${date}T${time}`, displayTimezone),
    storageTimezone,
  ).slice(0, 16);
}

/** A chosen time or locked commitment must never become an automatic start. */
export function taskTimeProvenance(
  task: Task,
  explicitTimeSelection = false,
): Task {
  if (
    explicitTimeSelection ||
    (task.preparationAutoStart === true &&
      (task.kind === "fixed" || task.locked || !task.movable))
  )
    return { ...task, preparationAutoStart: false };
  return task;
}

/** Keep the last displayed time when a one-off automatic activity is finished. */
export function snapshotTaskPlacement(
  task: Task,
  placement: TaskPlacement | undefined,
  timezone: string,
): Task {
  if (
    task.recurrence !== "none" ||
    task.preparationAutoStart !== true ||
    placement?.taskId !== task.id ||
    placement.start === null ||
    !Number.isFinite(placement.start)
  )
    return task;
  const start = localAt(placement.start, timezone).slice(0, 16);
  return {
    ...task,
    earliest: start,
    scheduledStart: start,
    preparationAutoStart: false,
  };
}

/** The engine sees explicit choices, including a deliberate clear, as overrides. */
export function taskSuggestionOverrides(
  task: Task,
  edited: ReadonlySet<TaskDraftField>,
): Partial<Task> {
  return Object.fromEntries(
    [...edited].map((field) => [field, task[field]]),
  ) as Partial<Task>;
}

/** Optional controls reopen blank while the persisted scheduling bounds stay valid. */
export function taskForEditing(task: Task, currentStart?: string): Task {
  const derivedStart =
    currentStart &&
    task.preparationAutoStart === true &&
    task.kind !== "fixed" &&
    !task.locked &&
    task.movable;
  return {
    ...task,
    ...(derivedStart
      ? { earliest: currentStart, scheduledStart: currentStart }
      : {}),
    deadline: task.omittedFields?.includes("deadline") ? "" : task.deadline,
    windowStart: task.omittedFields?.includes("windowStart")
      ? ""
      : task.windowStart,
    windowEnd: task.omittedFields?.includes("windowEnd") ? "" : task.windowEnd,
  };
}

export function withOptionalTaskField(
  task: Task,
  field: NonNullable<Task["omittedFields"]>[number],
  blank: boolean,
): Task["omittedFields"] {
  const fields = new Set(task.omittedFields);
  if (blank) fields.add(field);
  else fields.delete(field);
  return [...fields];
}

/** Validate explicit fields and derive neutral bounds for unused optional controls. */
export function taskForSaving(value: Task, timezone: string): Task {
  const draft = taskTimeProvenance(value);
  if (!draft.title.trim()) throw Error("Give the task a name.");
  if (
    !Number.isFinite(draft.minutes) ||
    draft.minutes < 1 ||
    draft.minutes > 1440 ||
    !Number.isFinite(draft.travelMinutes) ||
    draft.travelMinutes < 0 ||
    draft.travelMinutes > 1440
  )
    throw Error(
      "Enter a positive duration of 1–1440 minutes and a travel allowance of 0–1440 minutes.",
    );
  const earliest = draft.earliest || draft.scheduledStart || "";
  if (!earliest) throw Error("Choose a start date and time for this task.");
  const from = zonedEpoch(earliest, timezone);
  const omittedFields = new Set(draft.omittedFields);
  let deadline = draft.deadline;
  if (!deadline) {
    omittedFields.add("deadline");
    const start = Temporal.PlainDateTime.from(earliest);
    const endOfDate = start.toPlainDate().add({ days: 1 }).toPlainDateTime();
    const occupiedStart = draft.scheduledStart
      ? Temporal.PlainDateTime.from(draft.scheduledStart)
      : start;
    const taskEnd = occupiedStart.add({ minutes: draft.minutes });
    deadline = (
      Temporal.PlainDateTime.compare(taskEnd, endOfDate) > 0
        ? taskEnd
        : endOfDate
    ).toString({ smallestUnit: "minute" });
  } else omittedFields.delete("deadline");
  if (zonedEpoch(deadline, timezone) < from)
    throw Error("Deadline must follow earliest time.");
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const field of ["windowStart", "windowEnd"] as const) {
    if (draft[field] && !timePattern.test(draft[field]))
      throw Error("Choose valid preferred window start and end times.");
    if (!draft[field]) omittedFields.add(field);
    else omittedFields.delete(field);
  }
  if (draft.scheduledStart) zonedEpoch(draft.scheduledStart, timezone);
  return {
    ...draft,
    earliest,
    deadline,
    windowStart: draft.windowStart || "00:00",
    windowEnd: draft.windowEnd || "00:00",
    omittedFields: [...omittedFields],
    ...(draft.kind === "fixed"
      ? {
          locked: true,
          movable: false,
          scheduledStart: draft.scheduledStart || earliest,
        }
      : {}),
  };
}
