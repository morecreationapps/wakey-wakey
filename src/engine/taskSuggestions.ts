import { Clock, RotaEntry, Settings, Task } from "../model";
import {
  planPreparation,
  PreparationActivity,
  recognizePreparationActivity,
} from "./preparation";
import { planShift, planTasks, workBounds } from "./planner";
import {
  addDays,
  displayDate,
  localAt,
  MINUTE,
  onDate,
  zonedEpoch,
} from "./time";
export { recognizePreparationActivity } from "./preparation";

export interface PreparationTaskSuggestion {
  minutes: number;
  earliest: string;
  scheduledStart: string | null;
  deadline: string;
  windowStart: string;
  windowEnd: string;
  linkedShiftId?: string;
  preparationAutoStart: boolean;
  explanation: string;
  conflict?: string;
}

const defaults: Record<PreparationActivity, number> = {
  laundry: 45,
  ironing: 30,
  lunch: 30,
  packing: 10,
  haircut: 30,
  meal: 30,
  windDown: 30,
  shower: 30,
  sleep: 30,
  clothes: 10,
  shopping: 60,
  cooking: 90,
  exercise: 30,
  project: 60,
};
const epoch = (local: string | null | undefined, timezone: string) => {
  try {
    return local ? zonedEpoch(local, timezone) : null;
  } catch {
    return null;
  }
};

/** Suggestions stay separate from form state: callers apply only untouched fields. */
export function suggestPreparationTask(
  title: string,
  entries: RotaEntry[],
  tasks: Task[],
  settings: Settings,
  clock: Clock,
  overrides: Partial<Task> = {},
  selectedShift?: RotaEntry,
): PreparationTaskSuggestion | null {
  const activity = recognizePreparationActivity(title);
  return activity
    ? suggest(
        title,
        activity,
        entries,
        tasks,
        settings,
        clock,
        overrides,
        selectedShift,
      )
    : null;
}
export function defaultPreparationTaskStart(
  entries: RotaEntry[],
  tasks: Task[],
  settings: Settings,
  clock: Clock,
  overrides: Partial<Task> = {},
  selectedShift?: RotaEntry,
): PreparationTaskSuggestion | null {
  return suggest(
    overrides.title ?? "Preparation task",
    undefined,
    entries,
    tasks,
    settings,
    clock,
    overrides,
    selectedShift,
  );
}

function suggest(
  title: string,
  activity: PreparationActivity | undefined,
  entries: RotaEntry[],
  tasks: Task[],
  settings: Settings,
  clock: Clock,
  overrides: Partial<Task>,
  selectedShift?: RotaEntry,
): PreparationTaskSuggestion | null {
  const current = planPreparation(
      entries,
      tasks,
      settings,
      clock,
      selectedShift ? { selectedShift } : {},
    ),
    next = current.nextShift;
  if (!next || !current.preparationDate) return null;
  const date = current.preparationDate,
    dayStart = onDate(date, "00:00", next.timezone),
    dayEnd = onDate(addDays(date, 1), "00:00", next.timezone);
  const suggestionClock = {
    now: () =>
      clock.now() < dayEnd ? Math.max(dayStart, clock.now()) : dayStart,
  };
  const plan = current.shiftPlan ?? planShift(next, settings, entries, tasks),
    event = (kind: string) => plan.events.find((e) => e.kind === kind)?.at;
  const wind = event("windDown"),
    bed = event("bedtime");
  let minutes =
    overrides.minutes ??
    (activity === "windDown" &&
    settings.windDown !== null &&
    settings.windDown > 0
      ? settings.windDown
      : activity === "sleep" &&
          settings.latency !== null &&
          settings.latency > 0
        ? settings.latency
        : activity
          ? defaults[activity]
          : 30);
  const id = overrides.id ?? "__preparation_suggestion";
  const context = tasks.filter((t) => t.id !== id);
  const stages = current.rows.filter(
    (r) =>
      r.taskId !== id &&
      !["completed", "skipped", "deferred"].includes(r.status),
  );
  const windRows = stages.filter((r) => r.kind === "windDown" && r.at !== null),
    showerRows = stages.filter(
      (r) =>
        r.taskId &&
        recognizePreparationActivity(
          context.find((t) => t.id === r.taskId)?.title ?? "",
        ) === "shower" &&
        r.at !== null,
    );
  let until = Math.min(
    dayEnd - MINUTE,
    ...[
      wind,
      ...windRows.map((r) => r.at!),
      ...showerRows.map((r) => r.at!),
    ].filter((v): v is number => v !== undefined),
  );
  let start: number | null =
    activity === "sleep"
      ? (bed ?? null)
      : activity === "windDown"
        ? bed !== undefined
          ? bed - minutes * MINUTE
          : null
        : activity === "shower"
          ? wind !== undefined && bed !== undefined
            ? until - minutes * MINUTE
            : null
          : activity === "meal"
            ? until - minutes * MINUTE
            : null;
  const explicit =
    overrides.scheduledStart !== undefined
      ? overrides.scheduledStart
      : overrides.earliest !== undefined
        ? overrides.earliest
        : undefined;
  if (explicit !== undefined) start = epoch(explicit, settings.timezone);
  const neutralDeadline = localAt(dayEnd - MINUTE, settings.timezone),
    earliest = localAt(start ?? dayStart, settings.timezone);
  const candidate: Task = {
    id,
    title,
    kind: "essential",
    minutes,
    earliest,
    deadline: overrides.deadline || neutralDeadline,
    windowStart: overrides.windowStart || "00:00",
    windowEnd: overrides.windowEnd || "00:00",
    priority: 2,
    recurrence: "none",
    location: "",
    travelMinutes: 0,
    movable: true,
    splittable: false,
    locked: false,
    scheduledStart: start !== null ? localAt(start, settings.timezone) : null,
    state: "pending",
    linkedShiftId: next.id,
    omittedFields: ["deadline", "windowStart", "windowEnd", "travelMinutes"],
    ...overrides,
  };
  candidate.title = title;
  candidate.id = id;
  candidate.minutes = minutes;
  candidate.linkedShiftId = next.id;
  candidate.deadline = overrides.deadline || neutralDeadline;
  candidate.windowStart = overrides.windowStart || "00:00";
  candidate.windowEnd = overrides.windowEnd || "00:00";
  candidate.omittedFields = (
    ["deadline", "windowStart", "windowEnd", "travelMinutes"] as const
  ).filter((f) =>
    f === "travelMinutes"
      ? overrides.travelMinutes === undefined
      : !overrides[f],
  );
  candidate.preparationAutoStart =
    explicit === undefined &&
    candidate.kind !== "fixed" &&
    !candidate.locked &&
    candidate.movable;
  if (
    !["sleep", "windDown", "shower"].includes(activity ?? "") &&
    explicit === undefined
  ) {
    // Use the existing safety scheduler for daytime tasks, including its laundry
    // and packing dependencies, instead of inventing a booking or fixed time.
    const requestedDeadline = epoch(overrides.deadline, settings.timezone);
    const request = {
      ...candidate,
      kind: "essential" as const,
      movable: true,
      locked: false,
      scheduledStart: null,
      earliest: localAt(dayStart, settings.timezone),
      deadline: localAt(
        Math.max(dayStart, Math.min(until, requestedDeadline ?? until)),
        settings.timezone,
      ),
    };
    if (activity === "meal")
      request.earliest = localAt(
        Math.max(dayStart, until - minutes * MINUTE),
        settings.timezone,
      );
    let placements = planTasks(
      [
        ...context.filter(
          (t) =>
            !["windDown", "shower", "sleep"].includes(
              recognizePreparationActivity(t.title) ?? "",
            ),
        ),
        request,
      ],
      entries,
      settings,
      suggestionClock,
      2,
    );
    let p = placements.find((p) => p.taskId === id);
    if (p?.start === null && activity === "meal") {
      request.earliest = localAt(dayStart, settings.timezone);
      placements = planTasks(
        [
          ...context.filter(
            (t) =>
              !["windDown", "shower", "sleep"].includes(
                recognizePreparationActivity(t.title) ?? "",
              ),
          ),
          request,
        ],
        entries,
        settings,
        suggestionClock,
        2,
      );
      p = placements.find((p) => p.taskId === id);
    }
    start = p?.start ?? null;
    candidate.earliest = localAt(start ?? dayStart, settings.timezone);
    candidate.scheduledStart =
      start !== null ? localAt(start, settings.timezone) : null;
  } else if (
    activity === "shower" &&
    explicit === undefined &&
    start !== null
  ) {
    // Find the latest free space before wind-down. Existing appointments keep
    // their original times; a shower moves earlier when its default slot clashes.
    const busy = stages
      .filter(
        (r) =>
          r.at !== null &&
          r.end !== null &&
          r.taskId &&
          context.some(
            (t) =>
              t.id === r.taskId &&
              (t.kind === "fixed" || t.locked || !t.movable),
          ),
      )
      .map((r) => ({
        start:
          r.at! -
          (context.find((t) => t.id === r.taskId)?.travelMinutes ?? 0) * MINUTE,
        end: r.end!,
      }));
    for (const e of entries) {
      try {
        const b = workBounds(e);
        if (b)
          busy.push({
            start:
              b.start -
              ((settings.outboundMax ?? 0) +
                (settings.arrivalBuffer ?? 0) +
                settings.routines
                  .filter((r) => r.essential)
                  .reduce((n, r) => n + (r.minutes ?? 0), 0)) *
                MINUTE,
            end:
              b.end +
              ((settings.returnMinutes ?? 0) +
                (settings.postWorkMinutes ?? 0)) *
                MINUTE,
          });
      } catch {
        /* Invalid work inputs remain visible in the plan. */
      }
    }
    let stop = until;
    for (let attempts = 0; attempts <= busy.length; attempts++) {
      start = stop - minutes * MINUTE;
      const conflicts = busy.filter((b) => start! < b.end && stop > b.start);
      if (!conflicts.length) break;
      stop = Math.min(...conflicts.map((b) => b.start));
    }
    candidate.earliest = localAt(start, settings.timezone);
    candidate.scheduledStart = localAt(start, settings.timezone);
  }
  const scheduled = planPreparation(
    entries,
    [...context, candidate],
    settings,
    clock,
    { selectedShift: next },
  );
  const row = scheduled.rows.find((r) => r.taskId === id),
    placement = scheduled.placements.find((p) => p.taskId === id);
  let conflict =
    row?.conflict ?? (placement?.start === null ? placement.reason : undefined);
  if (placement?.start === null && explicit === undefined) start = null;
  if (start === null)
    conflict =
      conflict ??
      "Review the sleep, wake and preparation settings before choosing this task's start time.";
  if (minutes <= 0 || !Number.isFinite(minutes))
    conflict =
      "Enter a positive duration before calculating a suitable start time.";
  if (row?.at !== null && row?.at !== undefined && explicit === undefined) {
    start = row.at;
    candidate.earliest = localAt(start, settings.timezone);
    candidate.scheduledStart = candidate.earliest;
  }
  if (start !== null && start < clock.now())
    conflict = [
      conflict,
      "This preparation start is in the past; review its time or choose a later shift before saving a new activity.",
    ]
      .filter(Boolean)
      .join(" ");
  const explanation = `Suggested editable ${minutes}-minute activity for ${displayDate(date, settings.dateFormat)}, the calendar day before ${next.duty || "your selected shift"}. ${activity === "shower" ? "It fits before the entered wind-down routine, calculated backwards from bedtime." : activity === "sleep" ? "This time starts the bedtime routine; full planned sleep remains protected in Shift Plan." : activity === "windDown" ? "Its duration is calculated backwards from planned bedtime using your sleep and wake settings." : "Work, travel, planned sleep, task dependencies and saved commitments remain protected."}`;
  return {
    minutes,
    earliest:
      overrides.earliest !== undefined
        ? overrides.earliest
        : start !== null
          ? localAt(start, settings.timezone)
          : "",
    scheduledStart:
      overrides.scheduledStart !== undefined
        ? overrides.scheduledStart
        : start !== null
          ? localAt(start, settings.timezone)
          : null,
    deadline: overrides.deadline ?? "",
    windowStart: overrides.windowStart ?? "",
    windowEnd: overrides.windowEnd ?? "",
    linkedShiftId: next.id,
    preparationAutoStart: candidate.preparationAutoStart,
    explanation,
    ...(conflict ? { conflict } : {}),
  };
}
