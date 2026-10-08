import {
  Clock,
  DayStatus,
  RotaEntry,
  Settings,
  Task,
  TaskState,
} from "../model";
import {
  essentialPreparation,
  nextWork,
  orderedPreparationRoutines,
  planShift,
  planTasks,
  preparationActivityKind,
  routinePreparationKind,
  ShiftPlan,
  TaskPlacement,
  workBounds,
} from "./planner";
import {
  addDays,
  calendarDaysBetween,
  dateInZone,
  localAt,
  MINUTE,
  zonedEpoch,
} from "./time";

export interface PreparationRow {
  id: string;
  label: string;
  kind: string;
  at: number | null;
  end: number | null;
  minutes: number | null;
  status: TaskState | "planned" | "needs-input" | "conflict";
  why: string;
  taskId?: string;
  occurrenceDate?: string;
  routineId?: string;
  conflict?: string;
}

export interface PreparationPlan {
  today: string;
  todayStatus: DayStatus;
  nextShift?: RotaEntry;
  shiftPlan?: ShiftPlan;
  preparesFor: "today" | "tomorrow" | "later" | "none";
  placements: TaskPlacement[];
  rows: PreparationRow[];
  missing: string[];
  conflicts: string[];
  provisional: boolean;
}

/** A recurring checklist action must never complete its entire saved series. */
export function completePreparationTask(
  task: Task,
  occurrenceDate?: string,
): Task {
  if (task.recurrence === "none") return { ...task, state: "completed" };
  if (!occurrenceDate) return task;
  return {
    ...task,
    occurrenceStates: {
      ...task.occurrenceStates,
      [occurrenceDate]: "completed",
    },
  };
}

const unique = (values: string[]) => [...new Set(values)];
const inactive = (state: TaskState) =>
  ["completed", "skipped", "deferred"].includes(state);
const safeEpoch = (
  local: string | null,
  timezone: string,
  disambiguation?: "earlier" | "later",
) => {
  try {
    return local ? zonedEpoch(local, timezone, disambiguation) : null;
  } catch {
    return null;
  }
};

/** A view of existing plans, never a task generator or a persisted timetable. */
export function planPreparation(
  entries: RotaEntry[],
  tasks: Task[],
  settings: Settings,
  clock: Clock,
  shared: { shiftPlan?: ShiftPlan; placements?: TaskPlacement[] } = {},
): PreparationPlan {
  const now = clock.now(),
    snapshotClock = { now: () => now };
  const today = dateInZone(snapshotClock, settings.timezone);
  const todayEntries = entries.filter((e) => e.date === today);
  // An overnight duty still in progress takes precedence over a same-date Rest.
  const working = entries.some((entry) => {
    try {
      const bounds = workBounds(entry);
      return !!bounds && bounds.start <= now && bounds.end > now;
    } catch {
      return false;
    }
  });
  const todayStatus: DayStatus =
    working || todayEntries.some((e) => e.status === "Work")
      ? "Work"
      : (todayEntries.find((e) => e.status !== "Unknown")?.status ?? "Unknown");
  const result: PreparationPlan = {
    today,
    todayStatus,
    preparesFor: "none",
    placements: [],
    rows: [],
    missing: [],
    conflicts: [],
    provisional: false,
  };
  let next = nextWork(entries, snapshotClock, settings.timezone);
  const invalidUpcoming = entries.filter(
    (entry) =>
      entry.status === "Work" &&
      entry.date >= today &&
      (!next || entry.date <= next.date) &&
      safeEpoch(entry.start, entry.timezone, entry.disambiguation) === null,
  );
  for (const entry of invalidUpcoming)
    result.missing.push(
      `Review the recorded work start on ${entry.date}; a valid time and timezone are needed to identify your next shift.`,
    );
  // An earlier incomplete Work record makes the identity of the next duty uncertain.
  if (invalidUpcoming.length) next = undefined;
  if (!next) {
    result.provisional = result.missing.length > 0;
    return result;
  }
  result.nextShift = next;
  const plan =
    shared.shiftPlan?.entryId === next.id
      ? shared.shiftPlan
      : planShift(next, settings, entries, tasks);
  result.shiftPlan = plan;
  result.missing.push(...plan.missing);
  result.conflicts.push(...plan.conflicts);
  const nextDate = localAt(
    zonedEpoch(next.start!, next.timezone, next.disambiguation),
    next.timezone,
  ).slice(0, 10);
  const localToday = dateInZone(snapshotClock, next.timezone);
  result.preparesFor =
    nextDate === localToday
      ? "today"
      : nextDate === addDays(localToday, 1)
        ? "tomorrow"
        : "later";
  const event = (kind: string) => plan.events.find((e) => e.kind === kind);
  const cutoff = event("departure")?.at ?? event("workStart")?.at;
  if (cutoff === undefined) {
    result.provisional = true;
    return result;
  }
  const selected = [...new Map(tasks.map((task) => [task.id, task])).values()];
  const horizon = Math.max(
    14,
    calendarDaysBetween(
      today,
      localAt(cutoff, settings.timezone).slice(0, 10),
    ) + 1,
  );
  const placements =
    horizon > 14 || !shared.placements
      ? planTasks(tasks, entries, settings, snapshotClock, horizon)
      : shared.placements;
  result.placements = placements;
  const linkedElsewhere = (task: Task) =>
    !!task.linkedShiftId && task.linkedShiftId !== next!.id;
  const relevant = (task: Task) => {
    if (linkedElsewhere(task)) return false;
    if (task.linkedShiftId === next!.id) return true;
    const earliest = safeEpoch(task.earliest, settings.timezone),
      deadline = safeEpoch(task.deadline, settings.timezone);
    const due =
      deadline !== null &&
      deadline >= now - 24 * 60 * MINUTE &&
      deadline <= cutoff;
    const placed = placements.some(
      (p) =>
        p.taskId === task.id &&
        p.start !== null &&
        p.start < cutoff &&
        p.end! > now,
    );
    return (
      due ||
      placed ||
      (earliest !== null &&
        earliest <= cutoff &&
        task.kind === "essential" &&
        deadline !== null &&
        deadline <= cutoff)
    );
  };
  const appendTask = (
    task: Task,
    placement: TaskPlacement | undefined,
    occurrenceDate?: string,
    state = task.state,
  ) => {
    const key = `task:${task.id}:${occurrenceDate ?? "once"}`;
    if (
      result.rows.some(
        (row) => row.id === key || row.id.startsWith(`${key}:part:`),
      )
    )
      return;
    if (inactive(state)) {
      result.rows.push({
        id: key,
        label: task.title,
        kind: "task",
        at: null,
        end: null,
        minutes: task.minutes,
        status: state,
        why: `Saved as ${state}; this activity has not been rescheduled.`,
        taskId: task.id,
        ...(occurrenceDate ? { occurrenceDate } : {}),
      });
      return;
    }
    const parts =
      placement?.parts ??
      (placement?.start !== null &&
      placement?.start !== undefined &&
      placement.end !== null
        ? [{ start: placement.start, end: placement.end }]
        : []);
    if (!parts.length) {
      const why =
        placement?.reason ??
        "Enter or review this saved activity's timing before it can be placed safely.";
      result.rows.push({
        id: key,
        label: task.title,
        kind: "task",
        at: null,
        end: null,
        minutes: task.minutes,
        status: "needs-input",
        why,
        taskId: task.id,
        ...(occurrenceDate ? { occurrenceDate } : {}),
      });
      if (/^(?:Enter|Review|Plan remains provisional)/.test(why))
        result.missing.push(`“${task.title}”: ${why}`);
      else result.conflicts.push(`“${task.title}”: ${why}`);
      return;
    }
    parts.forEach((part, i) => {
      result.rows.push({
        id: parts.length === 1 ? key : `${key}:part:${i}`,
        label: task.title,
        kind: "task",
        at: part.start,
        end: part.end,
        minutes: (part.end - part.start) / MINUTE,
        status: placement?.conflict ? "conflict" : state,
        why: `${placement!.reason}${task.travelMinutes > 0 ? ` ${task.travelMinutes} minutes of entered travel are reserved before this activity.` : ""}`,
        taskId: task.id,
        ...(occurrenceDate ? { occurrenceDate } : {}),
        ...(placement?.conflict ? { conflict: placement.conflict } : {}),
      });
    });
    if (placement?.conflict)
      result.conflicts.push(`“${task.title}”: ${placement.conflict}`);
  };
  for (const task of selected.filter(relevant)) {
    if (task.recurrence === "none" || inactive(task.state)) {
      appendTask(
        task,
        placements.find((p) => p.taskId === task.id),
      );
      continue;
    }
    for (const placement of placements.filter(
      (p) =>
        p.taskId === task.id &&
        (!p.occurrenceDate ||
          (p.occurrenceDate >= today &&
            p.occurrenceDate <=
              localAt(cutoff, settings.timezone).slice(0, 10))) &&
        (p.start === null || p.start < cutoff),
    ))
      appendTask(
        task,
        placement,
        placement.occurrenceDate,
        task.occurrenceStates?.[placement.occurrenceDate ?? ""] ?? task.state,
      );
    for (const [date, state] of Object.entries(task.occurrenceStates ?? {})) {
      if (
        date >= today &&
        date <= localAt(cutoff, settings.timezone).slice(0, 10) &&
        inactive(state)
      )
        appendTask(task, undefined, date, state);
    }
  }
  const addEvent = (kind: string, label: string, endKind?: string) => {
    const start = event(kind),
      end = endKind ? (event(endKind)?.at ?? null) : null;
    if (!start) return;
    result.rows.push({
      id: `event:${next!.id}:${kind}`,
      label,
      kind,
      at: start.at,
      end,
      minutes: end !== null ? Math.max(0, (end - start.at) / MINUTE) : null,
      status: "planned",
      why: start.why,
    });
  };
  addEvent("windDown", "Wind down", "bedtime");
  addEvent("bedtime", "Planned bedtime", "sleepStart");
  addEvent("sleepStart", "Planned sleep window", "wake");
  addEvent("wake", "Wake up");
  const prepare = event("prepare"),
    departure = event("departure");
  const prep = essentialPreparation(settings);
  const routines = orderedPreparationRoutines(settings);
  if (
    prepare &&
    departure &&
    prep.minutes !== null &&
    Math.abs((departure.at - prepare.at) / MINUTE - prep.minutes) < 0.0001
  ) {
    let cursor = prepare.at;
    for (const routine of routines) {
      if (routine.minutes === null) continue;
      const suggested = settings.origins[routine.id] === "suggested";
      const why = `${suggested ? "Suggested editable duration" : "Entered duration"}: ${routine.minutes} minutes for this selected essential routine. ${routine.includes.length ? `Combined activities (${routine.includes.join(", ")}) count once.` : "It is part of the existing preparation allowance."}`;
      result.rows.push({
        id: `routine:${next.id}:${routine.id}`,
        label: routine.name,
        kind: "routine",
        at: cursor,
        end: cursor + routine.minutes * MINUTE,
        minutes: routine.minutes,
        status: "planned",
        why,
        routineId: routine.id,
      });
      if (suggested)
        result.missing.push(
          `Confirm the suggested duration for “${routine.name}” (${routine.minutes} minutes).`,
        );
      cursor += routine.minutes * MINUTE;
    }
  } else if (prepare) addEvent("prepare", "Get ready", "departure");
  for (const row of result.rows.filter((r) => r.routineId)) {
    const routine = routines.find((r) => r.id === row.routineId)!;
    const kind = routinePreparationKind(routine),
      required =
        kind === "ironing"
          ? "laundry"
          : kind === "packing"
            ? "lunch"
            : undefined;
    if (!required) continue;
    for (const task of selected.filter(
      (t) => relevant(t) && preparationActivityKind(t.title) === required,
    )) {
      const before = result.rows.filter((r) => r.taskId === task.id);
      if (before.some((r) => r.status === "completed")) continue;
      if (
        !before.length ||
        before.some(
          (r) => r.end === null || r.end > row.at! || r.status === "conflict",
        )
      ) {
        row.status = "conflict";
        row.conflict = `“${task.title}” must finish before “${row.label}”; move or defer the dependent activity.`;
        result.conflicts.push(row.conflict);
      }
    }
  }
  addEvent("departure", "Leave home");
  result.rows.sort(
    (a, b) =>
      (a.at ?? Infinity) - (b.at ?? Infinity) || a.id.localeCompare(b.id),
  );
  result.missing = unique(result.missing);
  result.conflicts = unique(result.conflicts);
  result.provisional =
    plan.provisional ||
    result.missing.length > 0 ||
    result.conflicts.length > 0;
  return result;
}
