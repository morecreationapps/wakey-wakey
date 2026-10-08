import {
  Clock,
  DayStatus,
  RotaEntry,
  Settings,
  Task,
  TaskState,
} from "../model";
import {
  nextWork,
  planShift,
  planTasks,
  preparationActivityKind,
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
  onDate,
  zonedEpoch,
} from "./time";
import { beforeShiftSleepPreferences } from "./beforeShiftSleep";

export type PreparationActivity =
  | "laundry"
  | "ironing"
  | "lunch"
  | "packing"
  | "haircut"
  | "meal"
  | "windDown"
  | "shower"
  | "sleep"
  | "clothes"
  | "shopping"
  | "cooking"
  | "exercise"
  | "project";

/** Recognise an activity, not a location, booking, or a combined routine. */
export function recognizePreparationActivity(
  title: string,
): PreparationActivity | undefined {
  const combined = title.split(/\s*(?:\band\b|\bthen\b|[&+,;])\s*/i);
  if (
    combined.length > 1 &&
    combined.some((part) => recognizePreparationActivity(part) !== undefined)
  )
    return undefined;
  const text = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (
    /\b(?:shower|showering) (?:for|before) (?:bed|bedtime|sleep)\b|^bedtime shower$|^(?:take |have |having |taking )?(?:a )?shower$/.test(
      text,
    )
  )
    return "shower";
  if (/\bwind(?:ing)? down\b|^winddown$/.test(text)) return "windDown";
  if (
    /^(?:go|going) to (?:sleep|bed)$|^bedtime$|^get to sleep$|^sleep$/.test(
      text,
    )
  )
    return "sleep";
  if (
    /\blast (?:meal|dinner)\b|\b(?:evening meal|dinner)\b|\bmeal before (?:bed|bedtime|sleep)\b/.test(
      text,
    )
  )
    return "meal";
  if (
    /\b(?:haircut|hair cut|hair trim)\b|\bcut (?:my |your |their )?hair\b/.test(
      text,
    )
  )
    return "haircut";
  if (/\blay(?:ing)? out (?:work )?clothes\b/.test(text)) return "clothes";
  if (/\b(?:grocery shopping|food shopping)\b/.test(text)) return "shopping";
  if (/\bbatch cooking\b/.test(text)) return "cooking";
  if (/^exercise$/.test(text)) return "exercise";
  if (/^personal project$/.test(text)) return "project";
  return preparationActivityKind(title);
}

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
  preparationDate?: string;
  shiftPlan?: ShiftPlan;
  preparesFor: "today" | "tomorrow" | "later" | "none";
  placements: TaskPlacement[];
  rows: PreparationRow[];
  missing: string[];
  conflicts: string[];
  provisional: boolean;
}

/** Provisional task calculations use existing values, never overwrite settings
 * or assert that an unknown rota day is actually a rest day. */
export function preparationCalculationContext(
  entries: RotaEntry[],
  settings: Settings,
  date: string,
  shift: RotaEntry,
) {
  const warnings: string[] = [],
    origins = { ...settings.origins };
  const suggested: string[] = [];
  for (const [key, origin] of Object.entries(origins)) {
    const raw = (settings as unknown as Record<string, unknown>)[key];
    const duration =
      typeof raw === "number"
        ? raw
        : settings.routines.find((r) => r.id === key)?.minutes;
    if (
      origin === "suggested" &&
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0
    ) {
      origins[key] = "entered";
      suggested.push(key);
    }
  }
  if (suggested.length)
    warnings.push(
      "This editable suggestion uses your existing starting values; confirm the relevant sleep, preparation and travel settings before relying on it.",
    );
  const calculated: Settings = { ...settings, origins };
  if (!settings.timezoneConfirmed && settings.timezone === shift.timezone) {
    calculated.timezoneConfirmed = true;
    warnings.push(
      `The suggestion uses the recorded ${shift.timezone} timezone; confirm your timezone setting before relying on it.`,
    );
  }
  if (
    !settings.restBed &&
    settings.restWake &&
    settings.sleepTarget !== null &&
    settings.sleepTarget > 0 &&
    settings.latency !== null &&
    settings.latency >= 0
  ) {
    try {
      calculated.restBed = localAt(
        onDate(date, settings.restWake, settings.timezone) -
          (settings.sleepTarget + settings.latency) * MINUTE,
        settings.timezone,
      ).slice(11, 16);
      warnings.push(
        "Previous-night sleep is protected by working backwards from your entered preparation-day wake time and full sleep target; your usual rest-day bedtime is still unconfirmed.",
      );
    } catch {
      /* Invalid wake preferences stay unavailable. */
    }
  }
  const dayEntries = entries.filter((e) => e.date === date);
  let planningEntries = entries;
  if (!dayEntries.length || dayEntries.some((e) => e.status === "Unknown")) {
    warnings.push(
      "Availability on the preparation day is unconfirmed. This is an editable suggestion around recorded work and commitments; review the rota before relying on it.",
    );
    planningEntries = entries.map((e) =>
      e.date === date && e.status === "Unknown"
        ? { ...e, status: "Rest" as const }
        : e,
    );
    if (!dayEntries.length)
      planningEntries = [
        ...planningEntries,
        {
          ...shift,
          id: `__provisional_preparation_${date}`,
          date,
          status: "Rest",
          start: null,
          end: null,
          duty: "",
          notes: "",
        },
      ];
  }
  let taskContext: { beforeShiftId: string } | undefined;
  try {
    const start = shift.start
        ? zonedEpoch(shift.start, shift.timezone, shift.disambiguation)
        : null,
      preferences =
        start !== null
          ? beforeShiftSleepPreferences(shift, settings, start)
          : null;
    const selectedPlan = preferences
        ? planShift(shift, calculated, planningEntries)
        : null,
      wind = selectedPlan?.events.find((e) => e.kind === "windDown")?.at;
    if (
      preferences &&
      !preferences.missing.length &&
      selectedPlan?.events.some((e) => e.kind === "wake") &&
      selectedPlan.events.some((e) => e.kind === "bedtime") &&
      wind !== undefined &&
      localAt(wind, shift.timezone).slice(0, 10) ===
        preferences.preparationDate &&
      (!settings.restWake || !settings.restBed)
    ) {
      taskContext = { beforeShiftId: shift.id };
      warnings.push(
        "Your pre-shift sleep preferences protect the coming night's full sleep target, using the calculated bedtime or usual wake fallback for any blank field. Waking and sleep availability earlier on the preparation day are still unconfirmed; these are editable provisional timings near the bedtime routine, around recorded work and commitments. Review them before relying on the schedule.",
      );
    }
  } catch {
    /* The selected plan already reports invalid shift dates. */
  }
  return {
    settings: calculated,
    entries: planningEntries,
    warnings,
    taskContext,
  };
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
const intersects = (a: Interval, b: Interval) =>
  a.start < b.end && b.start < a.end;
interface Interval {
  start: number;
  end: number;
  label: string;
}
/** A blank endpoint is neutral; the other entered endpoint still applies. */
function taskWindow(task: Task, date: string, settings: Settings) {
  const enteredStart =
      !!task.windowStart && !task.omittedFields?.includes("windowStart"),
    enteredEnd = !!task.windowEnd && !task.omittedFields?.includes("windowEnd");
  let start = onDate(
    date,
    enteredStart ? task.windowStart : "00:00",
    settings.timezone,
  );
  let end = onDate(
    date,
    enteredEnd ? task.windowEnd : "00:00",
    settings.timezone,
  );
  if (!enteredEnd || end <= start)
    end = onDate(
      addDays(date, 1),
      enteredEnd ? task.windowEnd : "00:00",
      settings.timezone,
    );
  return { start, end };
}
function latestStart(
  upper: number,
  minutes: number,
  travel: number,
  lower: number,
  busy: Interval[],
) {
  let stop = upper;
  for (let attempts = 0; attempts <= busy.length; attempts++) {
    const occupiedStart = stop - (minutes + travel) * MINUTE;
    if (occupiedStart < lower) return null;
    const clashes = busy.filter((b) =>
      intersects(b, { start: occupiedStart, end: stop, label: "activity" }),
    );
    if (!clashes.length) return occupiedStart + travel * MINUTE;
    stop = Math.min(...clashes.map((b) => b.start));
  }
  return null;
}
const bedtimeActivity = (task: Task) =>
  ["windDown", "shower", "sleep"].includes(
    recognizePreparationActivity(task.title) ?? "",
  );
const fixedTask = (task: Task) =>
  task.kind === "fixed" || task.locked || !task.movable;
const occurrenceOn = (task: Task, date: string, timezone: string) => {
  if (task.recurrence === "none") return undefined;
  const first = task.earliest.slice(0, 10),
    last = task.deadline.slice(0, 10);
  const day = localAt(onDate(date, "12:00", timezone), timezone).slice(0, 10);
  if (
    day < first ||
    day > last ||
    (task.recurrence === "weekly" && calendarDaysBetween(first, day) % 7 !== 0)
  )
    return null;
  return day;
};

/** Day-before preparation is derived without changing saved tasks or Shift Plan. */
export function planPreparation(
  entries: RotaEntry[],
  tasks: Task[],
  settings: Settings,
  clock: Clock,
  shared: {
    shiftPlan?: ShiftPlan;
    placements?: TaskPlacement[];
    selectedShift?: RotaEntry;
  } = {},
): PreparationPlan {
  const now = clock.now(),
    snapshotClock = { now: () => now },
    today = dateInZone(snapshotClock, settings.timezone);
  const todayEntries = entries.filter((e) => e.date === today);
  const working = entries.some((entry) => {
    try {
      const b = workBounds(entry);
      return !!b && b.start <= now && b.end > now;
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
  let next =
    shared.selectedShift ?? nextWork(entries, snapshotClock, settings.timezone);
  const invalidUpcoming = shared.selectedShift
    ? []
    : entries.filter(
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
  if (invalidUpcoming.length) next = undefined;
  if (!next) {
    result.provisional = result.missing.length > 0;
    return result;
  }
  const nextStart = safeEpoch(next.start, next.timezone, next.disambiguation);
  if (nextStart === null) {
    result.missing.push(
      "Review the selected shift start before scheduling its preparation.",
    );
    result.provisional = true;
    return result;
  }
  result.nextShift = next;
  const nextDate = localAt(nextStart, next.timezone).slice(0, 10),
    preparationDate = addDays(nextDate, -1);
  result.preparationDate = preparationDate;
  const localToday = dateInZone(snapshotClock, next.timezone);
  result.preparesFor =
    nextDate === localToday
      ? "today"
      : nextDate === addDays(localToday, 1)
        ? "tomorrow"
        : "later";
  const plan =
    shared.shiftPlan?.entryId === next.id
      ? shared.shiftPlan
      : planShift(next, settings, entries, tasks);
  result.shiftPlan = plan;
  result.missing.push(...plan.missing);
  const event = (kind: string) => plan.events.find((e) => e.kind === kind);
  const dayStart = onDate(preparationDate, "00:00", next.timezone),
    dayEnd = onDate(nextDate, "00:00", next.timezone);
  // Keep a historical day-before view when today's duty is the selected duty.
  const schedulerClock: Clock = { now: () => Math.min(now, dayStart) };
  const calculation = preparationCalculationContext(
    entries,
    settings,
    preparationDate,
    next,
  );
  const horizon = Math.max(
    14,
    calendarDaysBetween(
      dateInZone(schedulerClock, settings.timezone),
      nextDate,
    ) + 2,
  );
  const selected = [...new Map(tasks.map((task) => [task.id, task])).values()];
  const originalPlacements =
    shared.placements ??
    planTasks(tasks, entries, settings, schedulerClock, horizon);
  const relevant = selected.filter((task) => {
    if (task.linkedShiftId) return task.linkedShiftId === next!.id;
    const chosen = safeEpoch(
      task.scheduledStart ?? task.earliest,
      settings.timezone,
    );
    const due = safeEpoch(task.deadline, settings.timezone);
    return (
      (chosen !== null && chosen >= dayStart && chosen < dayEnd) ||
      (due !== null && due > dayStart && due <= dayEnd) ||
      originalPlacements.some(
        (p) =>
          p.taskId === task.id &&
          p.start !== null &&
          p.start >= dayStart &&
          p.start < dayEnd,
      )
    );
  });
  const occurrences = relevant.flatMap((task) => {
    const occurrenceDate = occurrenceOn(
      task,
      localAt(dayStart + 12 * 60 * MINUTE, settings.timezone).slice(0, 10),
      settings.timezone,
    );
    return occurrenceDate === null
      ? []
      : [
          {
            task,
            occurrenceDate,
            state: occurrenceDate
              ? (task.occurrenceStates?.[occurrenceDate] ?? task.state)
              : task.state,
          },
        ];
  });
  const routineTasks = occurrences.filter(({ task }) => bedtimeActivity(task));
  const ordinaryTasks = occurrences.filter(
    ({ task }) => !bedtimeActivity(task),
  );
  const bedtime = event("bedtime")?.at,
    windStart = event("windDown")?.at,
    sleepStart = event("sleepStart")?.at;
  const blocked: Interval[] = [];
  const availabilityIssues: string[] =
    next.timezone !== settings.timezone
      ? [
          `The selected shift uses ${next.timezone}, while task times and routine preferences use ${settings.timezone}. Review these timezones before relying on the preparation schedule; its previous calendar day is anchored in the selected shift's timezone.`,
        ]
      : [];
  availabilityIssues.push(...calculation.warnings);
  if (beforeShiftSleepPreferences(next, settings, nextStart))
    availabilityIssues.push(
      ...plan.conflicts,
      ...plan.missing.filter(
        (m) =>
          m.startsWith("Review bedtime") || m.startsWith("Review wake time"),
      ),
    );
  const block = (start: number, end: number, label: string) => {
    if (end > start) blocked.push({ start, end, label });
  };
  for (const entry of entries) {
    try {
      const bounds = workBounds(entry);
      if (!bounds) {
        if (
          entry.status === "Work" &&
          (entry.date === preparationDate ||
            addDays(entry.date, 1) === preparationDate)
        )
          availabilityIssues.push(
            `Review the work start and finish on ${entry.date}; this preparation day's availability cannot be confirmed.`,
          );
        continue;
      }
      const p =
        entry.id === next.id
          ? plan
          : planShift(entry, settings, entries, tasks);
      const prep =
        p.events.find((e) => e.kind === "prepare")?.at ??
        p.events.find((e) => e.kind === "departure")?.at ??
        bounds.start;
      block(
        prep,
        bounds.end +
          ((settings.returnMinutes ?? 0) + (settings.postWorkMinutes ?? 0)) *
            MINUTE,
        `work, travel and recovery (${entry.duty || entry.date})`,
      );
      if (entry.id !== next.id) {
        const start =
            p.events.find((e) => e.kind === "windDown")?.at ??
            p.events.find((e) => e.kind === "bedtime")?.at,
          wake = p.events.find((e) => e.kind === "wake")?.at;
        if (start !== undefined && wake !== undefined)
          block(start, wake, "another duty's protected sleep and wind-down");
        if (
          (entry.category === "Late" ||
            entry.category === "Night" ||
            localAt(bounds.end, entry.timezone).slice(0, 10) > entry.date) &&
          [
            settings.returnMinutes,
            settings.postWorkMinutes,
            settings.windDown,
            settings.latency,
            settings.sleepTarget,
          ].every((n) => n !== null && Number.isFinite(n) && n >= 0)
        ) {
          // Protect recovery after an overnight/late duty as well as the sleep
          // before it. This mirrors the existing task planner's full target.
          let recoveryBed =
            bounds.end +
            (settings.returnMinutes! +
              settings.postWorkMinutes! +
              settings.windDown!) *
              MINUTE;
          if (entry.category === "Late" && settings.lateBed) {
            let preferred = onDate(
              localAt(bounds.end, entry.timezone).slice(0, 10),
              settings.lateBed,
              entry.timezone,
            );
            if (preferred < bounds.end)
              preferred = onDate(
                addDays(localAt(bounds.end, entry.timezone).slice(0, 10), 1),
                settings.lateBed,
                entry.timezone,
              );
            recoveryBed = Math.max(recoveryBed, preferred);
          }
          let recoveryEnd =
            recoveryBed + (settings.latency! + settings.sleepTarget!) * MINUTE;
          if (entry.category === "Late" && settings.lateWake)
            recoveryEnd = Math.max(
              recoveryEnd,
              onDate(
                localAt(recoveryEnd, entry.timezone).slice(0, 10),
                settings.lateWake,
                entry.timezone,
              ),
            );
          block(
            recoveryBed - settings.windDown! * MINUTE,
            recoveryEnd,
            "post-duty recovery and full sleep target",
          );
        }
      }
    } catch {
      if (
        entry.status === "Work" &&
        (entry.date === preparationDate ||
          addDays(entry.date, 1) === preparationDate)
      )
        availabilityIssues.push(
          `Review the invalid work start or finish on ${entry.date}; this preparation day's availability cannot be confirmed.`,
        );
    }
  }
  const previousDayEntries = entries.filter((e) => e.date === preparationDate);
  if (
    previousDayEntries.some((e) => e.status === "Rest") &&
    settings.freeMinutes !== null &&
    Number.isFinite(settings.freeMinutes) &&
    settings.freeMinutes > 0
  ) {
    const free = onDate(preparationDate, "16:00", next.timezone);
    block(
      free,
      free + settings.freeMinutes * MINUTE,
      "protected rest-day personal time",
    );
  }
  if (
    !previousDayEntries.some((e) => e.status === "Work") &&
    settings.restWake &&
    settings.restBed &&
    settings.sleepTarget !== null &&
    settings.latency !== null &&
    settings.windDown !== null
  ) {
    try {
      const wake = onDate(preparationDate, settings.restWake, next.timezone);
      let restBed = onDate(preparationDate, settings.restBed, next.timezone);
      if (restBed >= wake)
        restBed = onDate(
          addDays(preparationDate, -1),
          settings.restBed,
          next.timezone,
        );
      const requiredBed =
        wake - (settings.sleepTarget + settings.latency) * MINUTE;
      block(
        Math.min(restBed, requiredBed) - settings.windDown * MINUTE,
        wake,
        "previous-day rest sleep and wind-down",
      );
    } catch {
      /* Invalid rest preferences are already surfaced by the task planner. */
    }
  }
  for (const task of selected.filter(
    (t) => fixedTask(t) && !bedtimeActivity(t) && !inactive(t.state),
  )) {
    const occurrence = occurrenceOn(
      task,
      localAt(dayStart + 12 * 60 * MINUTE, settings.timezone).slice(0, 10),
      settings.timezone,
    );
    if (occurrence === null) continue;
    const raw = task.scheduledStart ?? task.earliest,
      chosen = safeEpoch(
        occurrence ? `${occurrence}T${raw.slice(11, 16)}` : raw,
        settings.timezone,
      );
    if (chosen !== null)
      block(
        chosen - task.travelMinutes * MINUTE,
        chosen + task.minutes * MINUTE,
        `fixed commitment: ${task.title}`,
      );
  }
  const rowPlacements: TaskPlacement[] = [];
  const append = (
    task: Task,
    p: TaskPlacement | undefined,
    state: TaskState,
    occurrenceDate?: string,
  ) => {
    const parts =
      p?.parts ??
      (p?.start !== null && p?.start !== undefined && p.end !== null
        ? [{ start: p.start, end: p.end }]
        : []);
    if (!parts.length) {
      result.rows.push({
        id: `task:${task.id}:${occurrenceDate ?? "once"}`,
        label: task.title,
        kind: "task",
        at: null,
        end: null,
        minutes: task.minutes,
        status: inactive(state)
          ? state
          : p?.conflict
            ? "conflict"
            : "needs-input",
        why:
          p?.reason ??
          `Saved as ${state}; no scheduled time has been recorded.`,
        taskId: task.id,
        ...(occurrenceDate ? { occurrenceDate } : {}),
        ...(p?.conflict ? { conflict: p.conflict } : {}),
      });
      if (!inactive(state)) {
        const reason = p?.reason ?? "Choose a preparation time.";
        if (/^(?:Enter|Review|Plan remains provisional|A valid)/.test(reason))
          result.missing.push(`“${task.title}”: ${reason}`);
        else result.conflicts.push(`“${task.title}”: ${reason}`);
      }
      return;
    }
    for (const [i, part] of parts.entries()) {
      const wrongDate =
        localAt(part.start, next!.timezone).slice(0, 10) !== preparationDate;
      const conflict = unique([
        ...(p?.conflict ? [p.conflict] : []),
        ...(wrongDate
          ? [
              `This saved time is outside ${preparationDate}, the calendar day before the selected shift. Review its date; fixed appointments have not been moved.`,
            ]
          : []),
      ]).join(" ");
      if (conflict && p) p.conflict = conflict;
      result.rows.push({
        id: `task:${task.id}:${occurrenceDate ?? "once"}${parts.length > 1 ? `:part:${i}` : ""}`,
        label: task.title,
        kind:
          recognizePreparationActivity(task.title) === "windDown"
            ? "windDown"
            : recognizePreparationActivity(task.title) === "sleep"
              ? "bedtime"
              : "task",
        at: part.start,
        end: part.end,
        minutes: (part.end - part.start) / MINUTE,
        status: inactive(state) ? state : conflict ? "conflict" : state,
        why: `${p!.reason}${task.travelMinutes > 0 ? ` ${task.travelMinutes} minutes of entered travel are reserved before this activity.` : ""}`,
        taskId: task.id,
        ...(occurrenceDate ? { occurrenceDate } : {}),
        ...(conflict ? { conflict } : {}),
      });
      if (conflict && !inactive(state))
        result.conflicts.push(`“${task.title}”: ${conflict}`);
    }
  };
  const chosenFor = (task: Task, occurrenceDate?: string) => {
    const raw = task.scheduledStart ?? task.earliest;
    return safeEpoch(
      occurrenceDate ? `${occurrenceDate}T${raw.slice(11, 16)}` : raw,
      settings.timezone,
    );
  };
  // A selected routine replaces its generated stage. A shower belongs before
  // wind-down, so it never silently shortens the entered wind-down or sleep.
  const routineOrder = [...routineTasks].sort(
    (a, b) =>
      ({ sleep: 0, windDown: 1, shower: 2 })[
        recognizePreparationActivity(a.task.title) as
          "sleep" | "windDown" | "shower"
      ] -
        { sleep: 0, windDown: 1, shower: 2 }[
          recognizePreparationActivity(b.task.title) as
            "sleep" | "windDown" | "shower"
        ] || a.task.id.localeCompare(b.task.id),
  );
  let routineCutoff = windStart ?? bedtime ?? dayEnd;
  for (const { task, occurrenceDate, state } of routineOrder) {
    const kind = recognizePreparationActivity(task.title)!;
    const preferred =
      kind === "sleep"
        ? bedtime
        : kind === "windDown"
          ? task.preparationAutoStart && bedtime !== undefined
            ? bedtime - task.minutes * MINUTE
            : windStart
          : routineCutoff - task.minutes * MINUTE;
    let start =
      (task.scheduledStart &&
        (!task.preparationAutoStart || inactive(state))) ||
      fixedTask(task)
        ? chosenFor(task, occurrenceDate)
        : (preferred ?? null);
    if (inactive(state) && !task.scheduledStart && !fixedTask(task)) {
      append(task, undefined, state, occurrenceDate);
      continue;
    }
    const conflicts: string[] = [...availabilityIssues];
    if (
      task.preparationAutoStart &&
      !fixedTask(task) &&
      !inactive(state) &&
      kind === "shower" &&
      start !== null
    ) {
      try {
        const window = taskWindow(
          task,
          localAt(dayStart + 12 * 60 * MINUTE, settings.timezone).slice(0, 10),
          settings,
        );
        const deadline = safeEpoch(task.deadline, settings.timezone);
        start = latestStart(
          Math.min(routineCutoff, deadline ?? routineCutoff, window.end),
          task.minutes,
          task.travelMinutes,
          Math.max(
            dayStart,
            window.start,
            now >= dayStart && now < dayEnd ? now : dayStart,
          ),
          blocked,
        );
      } catch {
        start = null;
      }
    }
    if (
      !previousDayEntries.length ||
      previousDayEntries.some((e) => e.status === "Unknown")
    )
      conflicts.push(
        "Availability on the preparation day is not confirmed in the rota; review it before relying on this time.",
      );
    if (
      previousDayEntries.some(
        (e) => e.status === "Holiday" && e.leaveApproval !== "confirmed",
      )
    )
      conflicts.push(
        "The preparation day's holiday is not confirmed availability; the fixed rota has not been changed.",
      );
    if (
      !Number.isFinite(task.minutes) ||
      task.minutes <= 0 ||
      !Number.isFinite(task.travelMinutes) ||
      task.travelMinutes < 0
    )
      start = null;
    if (bedtime === undefined || windStart === undefined) {
      if (
        start !== null &&
        (fixedTask(task) || task.preparationAutoStart === false)
      )
        conflicts.push(
          "Your entered start is retained. The usual shift-day wake time and calculated bedtime are still needed to review this bedtime routine; no sleep opportunity has been shortened.",
        );
      else start = null;
    }
    if (start === null) {
      const reason =
        bedtime !== undefined &&
        windStart !== undefined &&
        task.minutes > 0 &&
        Number.isFinite(task.minutes)
          ? "No permitted previous-day bedtime slot fits around work, travel, fixed commitments and protected sleep; move or edit this activity."
          : "A valid duration, wake time and planned bedtime are needed before this bedtime activity can be scheduled.";
      const p: TaskPlacement = {
        taskId: task.id,
        start: null,
        end: null,
        reason,
        ...(conflicts.length || reason.startsWith("No permitted")
          ? {
              conflict: unique([
                ...conflicts,
                ...(reason.startsWith("No permitted") ? [reason] : []),
              ]).join(" "),
            }
          : {}),
        ...(occurrenceDate ? { occurrenceDate } : {}),
      };
      rowPlacements.push(p);
      append(task, p, state, occurrenceDate);
      continue;
    }
    const end = start + task.minutes * MINUTE,
      interval = {
        start: start - task.travelMinutes * MINUTE,
        end,
        label: task.title,
      };
    if (
      task.preparationAutoStart &&
      !inactive(state) &&
      now >= dayStart &&
      now < dayEnd &&
      start < now
    )
      conflicts.push(
        "This planned start has passed; mark the activity complete or review its time before relying on it.",
      );
    if (kind === "sleep" && bedtime !== undefined && start !== bedtime)
      conflicts.push(
        "This saved bedtime differs from the calculated bedtime; the existing Shift Plan sleep opportunity is unchanged.",
      );
    if (kind === "sleep" && sleepStart !== undefined && end > sleepStart)
      conflicts.push(
        "This bedtime activity extends into the protected planned sleep opportunity; shorten the activity or review the entered sleep latency.",
      );
    if (kind === "windDown" && end > bedtime!)
      conflicts.push(
        "Wind-down must finish by the calculated bedtime; it cannot shorten the protected sleep opportunity.",
      );
    if (kind === "shower" && end > routineCutoff)
      conflicts.push(
        "This shower overlaps the wind-down or bedtime routine; move it earlier or edit the routine.",
      );
    const earliest = safeEpoch(task.earliest, settings.timezone),
      deadline = safeEpoch(task.deadline, settings.timezone);
    if (earliest !== null && start < earliest && !task.preparationAutoStart)
      conflicts.push("The saved start precedes the entered earliest time.");
    if (
      deadline !== null &&
      end > deadline &&
      !task.omittedFields?.includes("deadline")
    )
      conflicts.push("The activity finishes after its entered deadline.");
    if (task.windowStart || task.windowEnd) {
      try {
        const window = taskWindow(
          task,
          localAt(start, settings.timezone).slice(0, 10),
          settings,
        );
        if (start < window.start || end > window.end)
          conflicts.push("This saved time is outside the preferred window.");
      } catch {
        conflicts.push(
          "Review the preferred window or daylight-saving choice.",
        );
      }
    }
    if (!inactive(state))
      conflicts.push(
        ...blocked
          .filter((b) => intersects(b, interval))
          .map((b) => `Overlaps ${b.label}.`),
      );
    const p: TaskPlacement = {
      taskId: task.id,
      start,
      end,
      reason: `${fixedTask(task) ? "Fixed or locked time retained." : "Saved editable preparation time retained."} ${kind === "shower" ? "Shower before wind-down; its duration is additional to the protected wind-down." : kind === "windDown" ? "Wind-down is calculated backwards from bedtime using your sleep and wake settings." : "Going to bed starts the bedtime routine; planned sleep duration and wake time remain in Shift Plan."}`,
      ...(occurrenceDate ? { occurrenceDate } : {}),
      ...(conflicts.length ? { conflict: unique(conflicts).join(" ") } : {}),
    };
    rowPlacements.push(p);
    append(task, p, state, occurrenceDate);
    if (!inactive(state)) {
      block(interval.start, interval.end, `bedtime activity: ${task.title}`);
      if (kind !== "sleep") routineCutoff = Math.min(routineCutoff, start);
    }
  }
  const normalCandidates = selected
    .filter((t) => !bedtimeActivity(t))
    .map((task) => {
      if (!ordinaryTasks.some((o) => o.task.id === task.id) || fixedTask(task))
        return task;
      const start = safeEpoch(task.earliest, settings.timezone),
        deadline = safeEpoch(task.deadline, settings.timezone),
        preferred = safeEpoch(task.scheduledStart, settings.timezone);
      if (start === null || deadline === null) return task;
      const auto = task.preparationAutoStart && !inactive(task.state);
      const automaticLower =
        now >= dayStart && now < dayEnd ? Math.max(dayStart, now) : dayStart;
      return {
        ...task,
        ...(auto ? { scheduledStart: null } : {}),
        ...(task.preparationAutoStart === false &&
        task.scheduledStart &&
        task.linkedShiftId === next!.id
          ? { locked: true, movable: false }
          : {}),
        earliest: localAt(
          auto ? automaticLower : Math.max(start, dayStart, preferred ?? start),
          settings.timezone,
        ),
        deadline: localAt(
          Math.min(deadline, dayEnd - MINUTE, routineCutoff),
          settings.timezone,
        ),
      };
    });
  const automaticMeals = ordinaryTasks.filter(
    ({ task, state }) =>
      task.preparationAutoStart &&
      !fixedTask(task) &&
      !inactive(state) &&
      recognizePreparationActivity(task.title) === "meal",
  );
  const normalPlacements = planTasks(
    normalCandidates.filter(
      (t) => !automaticMeals.some((m) => m.task.id === t.id),
    ),
    calculation.entries,
    calculation.settings,
    schedulerClock,
    horizon,
    calculation.taskContext,
  );
  const mealBusy: Interval[] = [
    ...blocked,
    ...normalPlacements.flatMap((p) =>
      (
        p.parts ??
        (p.start !== null && p.end !== null
          ? [{ start: p.start, end: p.end }]
          : [])
      ).map((part) => ({
        start:
          part.start -
          (selected.find((t) => t.id === p.taskId)?.travelMinutes ?? 0) *
            MINUTE,
        end: part.end,
        label: "scheduled activity",
      })),
    ),
  ];
  for (const { task, occurrenceDate } of automaticMeals) {
    let p: TaskPlacement;
    try {
      const window = taskWindow(
          task,
          localAt(dayStart + 12 * 60 * MINUTE, settings.timezone).slice(0, 10),
          settings,
        ),
        deadline = safeEpoch(task.deadline, settings.timezone);
      const upper = Math.min(
          routineCutoff,
          dayEnd - MINUTE,
          deadline ?? dayEnd,
          window.end,
        ),
        lower = Math.max(
          dayStart,
          window.start,
          now >= dayStart && now < dayEnd ? now : dayStart,
        );
      const chosen = latestStart(
        upper,
        task.minutes,
        task.travelMinutes,
        lower,
        mealBusy,
      );
      if (chosen === null)
        p = {
          taskId: task.id,
          start: null,
          end: null,
          reason:
            "No permitted previous-day meal slot fits before the bedtime routine without overlapping work, travel or commitments.",
        };
      else {
        const trial: Task = {
          ...task,
          earliest: localAt(chosen, settings.timezone),
          deadline: localAt(chosen + task.minutes * MINUTE, settings.timezone),
          scheduledStart: null,
          recurrence: "none",
        };
        p = planTasks(
          [
            ...normalCandidates.filter(
              (t) =>
                t.id !== task.id &&
                !automaticMeals.some((m) => m.task.id === t.id),
            ),
            trial,
          ],
          calculation.entries,
          calculation.settings,
          schedulerClock,
          horizon,
          calculation.taskContext,
        ).find((p) => p.taskId === task.id) ?? {
          taskId: task.id,
          start: null,
          end: null,
          reason: "Review this meal's date, window and duration.",
        };
        if (p.start !== null && p.end !== null) {
          p.reason =
            "Automatically placed in the latest permitted space before shower, wind-down and bedtime. Your entered duration and optional bounds are preserved.";
          mealBusy.push({
            start: p.start - task.travelMinutes * MINUTE,
            end: p.end,
            label: task.title,
          });
        }
      }
    } catch {
      p = {
        taskId: task.id,
        start: null,
        end: null,
        reason: "Review the meal's preferred window or daylight-saving choice.",
      };
    }
    normalPlacements.push({
      ...p,
      ...(occurrenceDate ? { occurrenceDate } : {}),
    });
  }
  for (const { task, occurrenceDate, state } of ordinaryTasks) {
    let p = normalPlacements.find(
      (p) =>
        p.taskId === task.id &&
        (!occurrenceDate || p.occurrenceDate === occurrenceDate),
    );
    // A missing departure input can prevent the general planner from reaching
    // its fixed-time branch. Keep a valid existing appointment time visible,
    // while retaining that missing-input reason as a review warning.
    if (
      p?.start === null &&
      /missing|still needed|Confirm/.test(p.reason) &&
      !inactive(state) &&
      (fixedTask(task) ||
        (task.preparationAutoStart === false &&
          !!task.scheduledStart &&
          task.linkedShiftId === next.id)) &&
      chosenFor(task, occurrenceDate) !== null &&
      Number.isFinite(task.minutes) &&
      task.minutes > 0 &&
      Number.isFinite(task.travelMinutes) &&
      task.travelMinutes >= 0
    ) {
      const review = planTasks(
        normalCandidates.map((candidate) =>
          candidate.id === task.id
            ? {
                ...candidate,
                linkedShiftId: undefined,
                locked: true,
                movable: false,
              }
            : candidate,
        ),
        entries,
        settings,
        schedulerClock,
        horizon,
      ).find(
        (placement) =>
          placement.taskId === task.id &&
          (!occurrenceDate || placement.occurrenceDate === occurrenceDate),
      );
      if (
        review?.start !== null &&
        review?.start !== undefined &&
        review.end !== null
      )
        p = {
          ...review,
          reason:
            "The existing chosen start is retained; missing planning inputs still need review before relying on this activity.",
          conflict: unique([
            p.reason,
            ...(review.conflict ? [review.conflict] : []),
          ]).join(" "),
        };
    }
    if (
      p?.start !== null &&
      p?.start !== undefined &&
      p.end !== null &&
      !inactive(state)
    ) {
      const routineClashes = blocked
        .filter(
          (b) =>
            b.label.startsWith("bedtime activity:") &&
            intersects(b, {
              start: p!.start! - task.travelMinutes * MINUTE,
              end: p!.end!,
              label: task.title,
            }),
        )
        .map((b) => `Overlaps ${b.label}.`);
      const issues = unique([
        ...(p.conflict ? [p.conflict] : []),
        ...routineClashes,
        ...availabilityIssues,
      ]);
      if (issues.length) p.conflict = issues.join(" ");
      if (
        task.preparationAutoStart === false &&
        task.scheduledStart &&
        !fixedTask(task)
      )
        p.reason =
          "Your explicitly chosen preparation start is retained; review any flagged conflicts before relying on this activity.";
    }
    if (inactive(state)) {
      const chosen =
        task.scheduledStart || fixedTask(task)
          ? chosenFor(task, occurrenceDate)
          : null;
      p =
        chosen !== null
          ? {
              taskId: task.id,
              start: chosen,
              end: chosen + task.minutes * MINUTE,
              reason: `Saved as ${state}; its recorded time is retained.`,
              ...(occurrenceDate ? { occurrenceDate } : {}),
            }
          : undefined;
    }
    if (p) rowPlacements.push(p);
    append(task, p, state, occurrenceDate);
  }
  const addStage = (
    kind: string,
    label: string,
    start: number | undefined,
    end: number | undefined,
  ) => {
    if (
      start === undefined ||
      localAt(start, next!.timezone).slice(0, 10) !== preparationDate
    )
      return;
    if (
      routineTasks.some(
        (o) =>
          recognizePreparationActivity(o.task.title) ===
          (kind === "windDown" ? "windDown" : "sleep"),
      )
    )
      return;
    const conflict = [
      ...availabilityIssues,
      ...(now >= dayStart && now < dayEnd && start < now
        ? [
            "This planned routine start has passed; review the routine before relying on the remaining preparation time.",
          ]
        : []),
      ...blocked
        .filter(
          (b) =>
            !b.label.startsWith("bedtime activity:") &&
            intersects(b, { start, end: end ?? start, label }),
        )
        .map((b) => `Overlaps ${b.label}.`),
    ].join(" ");
    result.rows.push({
      id: `event:${next!.id}:${kind}`,
      label,
      kind,
      at: start,
      end: end ?? null,
      minutes: end !== undefined ? Math.max(0, (end - start) / MINUTE) : null,
      status: conflict ? "conflict" : "planned",
      why:
        kind === "windDown"
          ? `Uses your ${settings.windDown}-minute wind-down before the calculated bedtime. This is part of the day-before routine.`
          : `The calculated bedtime precedes your ${settings.sleepTarget}-minute planned sleep opportunity. Estimated sleep latency is ${settings.latency} minutes; the required wake time stays in Shift Plan.`,
      ...(conflict ? { conflict } : {}),
    });
    if (conflict) result.conflicts.push(`${label}: ${conflict}`);
  };
  addStage("windDown", "Wind down", windStart, bedtime);
  addStage("bedtime", "Go to sleep", bedtime, sleepStart);
  if (
    bedtime !== undefined &&
    localAt(bedtime, next.timezone).slice(0, 10) !== preparationDate
  )
    result.conflicts.push(
      `The calculated bedtime is ${localAt(bedtime, next.timezone)}, outside the previous calendar day ${preparationDate}. Review the sleep and wake settings; bedtime has not been moved to a different date.`,
    );
  const overridden = new Set(rowPlacements.map((p) => p.taskId));
  result.placements = [
    ...originalPlacements.filter((p) => !overridden.has(p.taskId)),
    ...rowPlacements,
  ];
  result.rows.sort(
    (a, b) =>
      (a.at ?? Infinity) - (b.at ?? Infinity) || a.id.localeCompare(b.id),
  );
  result.missing = unique(result.missing);
  result.conflicts = unique(result.conflicts);
  result.provisional = result.missing.length > 0 || result.conflicts.length > 0;
  return result;
}
