import {
  Clock,
  RotaEntry,
  Routine,
  Settings,
  ShiftCategory,
  Task,
} from "../model";
import {
  addDays,
  calendarDaysBetween,
  dateInZone,
  localAt,
  MINUTE,
  onDate,
  zonedEpoch,
} from "./time";
import {
  beforeShiftBedtime,
  beforeShiftSleepPreferences,
} from "./beforeShiftSleep";

export interface PlanEvent {
  kind: string;
  label: string;
  at: number;
  why: string;
}
export interface ShiftPlan {
  entryId: string;
  events: PlanEvent[];
  missing: string[];
  conflicts: string[];
  provisional: boolean;
  availableSleepMinutes: number | null;
}
export interface Transition {
  id: string;
  from: ShiftCategory;
  to: ShiftCategory;
  nextDate: string;
  adjustmentDates: string[];
  advice: string[];
  missing: string[];
  provisional: boolean;
  dailySteps?: { date: string; bedtime: string; wake: string; why: string }[];
}
export interface TaskPlacement {
  taskId: string;
  start: number | null;
  end: number | null;
  reason: string;
  conflict?: string;
  parts?: { start: number; end: number }[];
  occurrenceDate?: string;
}
export interface PreparationTaskContext {
  /** Opt-in only for the previous date of this duty's explicit sleep pair. */
  beforeShiftId: string;
}
interface Interval {
  start: number;
  end: number;
  label: string;
}
const finiteMinutes = (n: number | null | undefined): n is number =>
  n !== null && n !== undefined && Number.isFinite(n) && n >= 0;
const validSleepTarget = (n: number | null | undefined): n is number =>
  finiteMinutes(n) && n > 0;
const inactiveOccurrence = (task: Task, date: string) =>
  ["completed", "skipped", "deferred"].includes(
    task.occurrenceStates?.[date] ?? "pending",
  );
const unique = (values: string[]) => [...new Set(values)];
const intersects = (a: Interval, b: Interval) =>
  a.start < b.end && b.start < a.end;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Only the app's recognisable saved preparation activities imply an order.
 * Free-form tasks remain independent; this does not create any new activity. */
export function preparationActivityKind(
  title: string,
): "laundry" | "ironing" | "lunch" | "packing" | undefined {
  const text = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const matches = [
    /\blaundry\b|\bwash(?:ing)? (?:work )?clothes\b/.test(text)
      ? "laundry"
      : null,
    /\b(?:iron|ironing)(?: (?:my|your|their|the))?(?: work)? (?:clothes|shirts?|uniform)\b|^ironing$/.test(
      text,
    )
      ? "ironing"
      : null,
    /\b(?:prepare|prep|make) lunch\b|\blunch preparation\b/.test(text)
      ? "lunch"
      : null,
    /\bpack(?:ing)? (?:work bag|lunch)\b/.test(text) ? "packing" : null,
  ].filter(Boolean);
  // A combined activity has one entered duration and cannot be split by inference.
  return matches.length === 1
    ? (matches[0] as ReturnType<typeof preparationActivityKind>)
    : undefined;
}

function preparationPrerequisites(task: Task, selected: Task[]): Task[] {
  const kind = preparationActivityKind(task.title);
  const required =
    kind === "ironing" ? "laundry" : kind === "packing" ? "lunch" : undefined;
  if (!required) return [];
  return selected.filter((other) => {
    if (
      other.id === task.id ||
      preparationActivityKind(other.title) !== required
    )
      return false;
    if (other.linkedShiftId && task.linkedShiftId)
      return other.linkedShiftId === task.linkedShiftId;
    // Unlinked activities on unrelated dates must not block a later preparation plan.
    return (
      other.earliest.slice(0, 10) <= task.deadline.slice(0, 10) &&
      other.deadline.slice(0, 10) >= task.earliest.slice(0, 10)
    );
  });
}

export function routinePreparationKind(routine: Routine) {
  const named = preparationActivityKind(routine.name);
  if (named) return named;
  const kinds = unique(
    routine.includes
      .map(preparationActivityKind)
      .filter((k): k is NonNullable<typeof k> => !!k),
  );
  return kinds.length === 1 ? kinds[0] : undefined;
}

/** Preserve each entered combined duration; only order whole selected routines. */
export function orderedPreparationRoutines(settings: Settings): Routine[] {
  const ids = new Set<string>();
  const routines = settings.routines.filter((routine) => {
    if (!routine.essential || ids.has(routine.id)) return false;
    ids.add(routine.id);
    return true;
  });
  const ordered: Routine[] = [],
    visited = new Set<string>();
  const visit = (routine: Routine) => {
    if (visited.has(routine.id)) return;
    visited.add(routine.id);
    const kind = routinePreparationKind(routine),
      required =
        kind === "ironing"
          ? "laundry"
          : kind === "packing"
            ? "lunch"
            : undefined;
    if (required)
      routines
        .filter((r) => routinePreparationKind(r) === required)
        .forEach(visit);
    ordered.push(routine);
  };
  routines.forEach(visit);
  return ordered;
}

function preferredBedAfter(
  end: number,
  preference: string,
  timezone: string,
): number {
  const date = localAt(end, timezone).slice(0, 10);
  const sameDate = onDate(date, preference, timezone);
  return sameDate >= end
    ? sameDate
    : onDate(addDays(date, 1), preference, timezone);
}

function fixedOccurrences(
  task: Task,
  timezone: string,
  from: number,
  to: number,
): number[] {
  const local = task.scheduledStart ?? task.earliest;
  if (task.recurrence === "none") return [zonedEpoch(local, timezone)];
  const first = local.slice(0, 10),
    earliest = zonedEpoch(task.earliest, timezone),
    deadline = zonedEpoch(task.deadline, timezone);
  const until = localAt(to, timezone).slice(0, 10),
    values: number[] = [];
  for (
    let date = localAt(from, timezone).slice(0, 10);
    date <= until;
    date = addDays(date, 1)
  ) {
    if (
      date < first ||
      inactiveOccurrence(task, date) ||
      (task.recurrence === "weekly" &&
        calendarDaysBetween(first, date) % 7 !== 0)
    )
      continue;
    const at = onDate(date, local.slice(11, 16), timezone);
    if (at >= earliest && at <= deadline) values.push(at);
  }
  return values;
}

/** An actual finish supersedes the scheduled finish and its overtime extension. */
export function effectiveEnd(entry: RotaEntry): number | null {
  const local = entry.actualEnd || entry.end;
  if (!local) return null;
  const end = zonedEpoch(local, entry.timezone, entry.disambiguation);
  if (entry.actualEnd) return end;
  if (!finiteMinutes(entry.overtimeMinutes))
    throw new RangeError("Overtime must be a non-negative number of minutes.");
  return end + entry.overtimeMinutes * MINUTE;
}

export function workBounds(
  entry: RotaEntry,
): { start: number; end: number } | null {
  if (entry.status !== "Work" || !entry.start) return null;
  const start = zonedEpoch(entry.start, entry.timezone, entry.disambiguation);
  const end = effectiveEnd(entry);
  if (end === null) return null;
  if (end <= start)
    throw new RangeError(
      "Finish must follow start; record the next date for an overnight duty.",
    );
  return { start, end };
}

/** Reject overlapping included activities rather than silently counting them twice. */
export function essentialPreparation(settings: Settings): {
  minutes: number | null;
  missing: string[];
} {
  const routines = settings.routines.filter((r) => r.essential);
  const missing: string[] = [];
  if (!settings.additionalPrepConfirmed)
    missing.push(
      "Confirm whether breakfast, dressing and other preparation are included or need extra time.",
    );
  if (!routines.length && !settings.additionalPrepConfirmed)
    missing.push("Essential preparation duration is still needed.");
  let total = 0;
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const routine of routines) {
    if (ids.has(routine.id)) continue;
    ids.add(routine.id);
    if (!finiteMinutes(routine.minutes)) {
      missing.push(`Duration for ${routine.name} is still needed.`);
      continue;
    }
    const activities = routine.includes
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (activities.some((x) => seen.has(x)))
      missing.push(
        `Review overlapping activities in ${routine.name}; preparation cannot be counted twice.`,
      );
    activities.forEach((x) => seen.add(x));
    total += routine.minutes;
  }
  const unknown = missing.some(
    (m) =>
      m.startsWith("Duration") ||
      m.startsWith("Review") ||
      m.startsWith("Essential"),
  );
  return { minutes: unknown ? null : total, missing };
}

function addDurationMissing(
  settings: Settings,
  keys: (keyof Settings)[],
  missing: string[],
) {
  const labels: Partial<Record<keyof Settings, string>> = {
    outboundMax: "Maximum outbound commute",
    arrivalBuffer: "Arrival buffer",
    returnMinutes: "Return commute",
    sleepTarget: "Sleep target",
    latency: "Estimated sleep latency",
    windDown: "Wind-down duration",
    postWorkMinutes: "Necessary post-work activity duration",
  };
  keys.forEach((k) => {
    if (!finiteMinutes(settings[k] as number | null))
      missing.push(`${labels[k] ?? k} is still needed.`);
    else if (k === "sleepTarget" && !validSleepTarget(settings.sleepTarget))
      missing.push(
        "Sleep target must be greater than zero; enter your chosen duration or leave it unknown.",
      );
    else if (settings.origins[k] === "suggested")
      missing.push(
        `Confirm the suggested starting value for ${(labels[k] ?? k).toLowerCase()}.`,
      );
  });
}

export function planShift(
  entry: RotaEntry,
  settings: Settings,
  entries: RotaEntry[],
  tasks: Task[] = [],
): ShiftPlan {
  const result: ShiftPlan = {
    entryId: entry.id,
    events: [],
    missing: [],
    conflicts: [],
    provisional: false,
    availableSleepMinutes: null,
  };
  if (entry.status !== "Work") return result;
  const { events, missing, conflicts } = result;
  const emit = (kind: string, label: string, at: number, why: string) =>
    events.push({ kind, label, at, why });
  if (!settings.timezoneConfirmed) missing.push("Confirm the rota timezone.");
  if (entry.timezone !== settings.timezone)
    missing.push(
      `This duty uses ${entry.timezone}, which differs from current settings (${settings.timezone}); review the timezone of your routine preferences.`,
    );
  let start: number | null = null,
    end: number | null = null;
  try {
    if (entry.start)
      start = zonedEpoch(entry.start, entry.timezone, entry.disambiguation);
    else missing.push("Shift start date/time is still needed.");
    if (entry.end || entry.actualEnd) end = effectiveEnd(entry);
    else missing.push("Shift finish date/time is still needed.");
  } catch (e) {
    missing.push(
      `Review the shift date/time or daylight-saving choice: ${errorText(e)}`,
    );
  }
  if (start === null) {
    result.provisional = true;
    return result;
  }
  emit(
    "workStart",
    "Start work",
    start,
    `Recorded ${entry.category.toLowerCase()} duty ${entry.duty || "(no duty code)"} in ${entry.timezone}.`,
  );
  if (end !== null) {
    emit(
      "workEnd",
      entry.actualEnd ? "Actual finish" : "Planned finish",
      end,
      entry.actualEnd
        ? "Your recorded actual finish supersedes the scheduled finish and overtime."
        : `Recorded finish plus ${entry.overtimeMinutes} minutes overtime, counted once.`,
    );
    if (end <= start)
      conflicts.push(
        "Finish does not follow start. Record the next finish date for an overnight duty.",
      );
    if (end - start > 18 * 60 * MINUTE)
      conflicts.push(
        "Duty exceeds 18 hours; review the recorded dates and times.",
      );
    if (finiteMinutes(settings.returnMinutes))
      emit(
        "home",
        "Return home",
        end + settings.returnMinutes * MINUTE,
        `Finish plus your separate ${settings.returnMinutes}-minute return commute.`,
      );
  }
  addDurationMissing(
    settings,
    [
      "outboundMax",
      "arrivalBuffer",
      "returnMinutes",
      "postWorkMinutes",
      "sleepTarget",
      "latency",
      "windDown",
    ],
    missing,
  );
  if (
    finiteMinutes(settings.outboundMin) &&
    finiteMinutes(settings.outboundMax) &&
    settings.outboundMin > settings.outboundMax
  )
    conflicts.push(
      "Minimum outbound commute exceeds the maximum; review the travel range.",
    );
  let departure: number | null = null,
    prepare: number | null = null;
  if (finiteMinutes(settings.arrivalBuffer)) {
    emit(
      "arrival",
      "Arrive at work",
      start - settings.arrivalBuffer * MINUTE,
      `Shift start minus the ${settings.arrivalBuffer}-minute arrival buffer.`,
    );
    if (finiteMinutes(settings.outboundMax)) {
      departure =
        start - (settings.arrivalBuffer + settings.outboundMax) * MINUTE;
      const range = finiteMinutes(settings.outboundMin)
        ? `${settings.outboundMin}–${settings.outboundMax}`
        : `${settings.outboundMax}`;
      emit(
        "departure",
        "Leave home",
        departure,
        `Shift start minus ${settings.arrivalBuffer} minutes arrival buffer and the upper ${settings.outboundMax}-minute allowance (${range} minutes entered).`,
      );
    }
  }
  const prep = essentialPreparation(settings);
  missing.push(...prep.missing);
  if (departure !== null && prep.minutes !== null) {
    prepare = departure - prep.minutes * MINUTE;
    emit(
      "prepare",
      "Start preparation",
      prepare,
      `Leave-home time minus ${prep.minutes} minutes total essential preparation. Combined activities count once.`,
    );
  }
  const localDate = localAt(start, entry.timezone).slice(0, 10);
  const beforeShift = beforeShiftSleepPreferences(entry, settings, start);
  if (beforeShift) missing.push(...beforeShift.missing);
  let wake: number | null = null;
  const preference =
    beforeShift?.wakeClock ??
    (entry.category === "Early"
      ? settings.earlyWake
      : entry.category === "Late"
        ? settings.lateWake
        : settings.restWake);
  if (entry.category === "Night") {
    missing.push(
      "Specialist night-shift sleep coaching has not been implemented or reviewed.",
    );
  } else if (preference) {
    try {
      wake = beforeShift?.wakeClock
        ? beforeShift.wake
        : onDate(localDate, preference, entry.timezone, entry.disambiguation);
      if (prepare !== null && wake !== null && wake > prepare) {
        conflicts.push(
          beforeShift?.wakeClock
            ? `Your wake time before a ${entry.category.toLowerCase()} shift (${preference}) is after required preparation; the earlier required wake is used and your entered preference is retained in Settings.`
            : `Your preferred wake time ${preference} is after required preparation; an earlier wake is needed.`,
        );
        wake = prepare;
      }
      const knownRequiredStart = Math.min(
        start,
        ...events
          .filter((e) => ["arrival", "departure", "prepare"].includes(e.kind))
          .map((e) => e.at),
      );
      if (
        beforeShift?.wakeClock &&
        prepare === null &&
        wake !== null &&
        wake > knownRequiredStart
      ) {
        conflicts.push(
          `Your wake time before a ${entry.category.toLowerCase()} shift (${preference}) is ${wake > start ? "later than the recorded work start" : "later than the known required arrival or departure time"}. Complete the travel and essential preparation settings to calculate a required earlier wake; your preference is retained and no usable bedtime routine has been invented.`,
        );
        wake = null;
      }
    } catch (e) {
      missing.push(
        `Review preferred wake time or daylight-saving choice: ${errorText(e)}`,
      );
    }
  } else if (entry.category === "Early") wake = prepare;
  else if (settings.consistentWake && settings.restWake) {
    try {
      wake = onDate(
        localDate,
        settings.restWake,
        entry.timezone,
        entry.disambiguation,
      );
    } catch (e) {
      missing.push(`Review rest-day wake time: ${errorText(e)}`);
    }
  } else
    missing.push(
      `Usual ${entry.category.toLowerCase()}-shift wake time is still needed; preparation start is not a wake recommendation.`,
    );
  if (wake !== null) {
    emit(
      "wake",
      "Wake up",
      wake,
      entry.category === "Early"
        ? beforeShift?.wakeClock
          ? "Uses your wake preference for the morning after the night before an early shift, at or before required essential preparation."
          : "Wake at or before essential preparation; use an earlier entered preference when it fits."
        : beforeShift?.wakeClock
          ? "Uses your wake preference for the morning after the night before a late shift; a late work start does not determine waking."
          : "Use your entered wake preference; a late preparation time does not determine waking.",
    );
    if (validSleepTarget(settings.sleepTarget)) {
      const sleepStart = wake - settings.sleepTarget * MINUTE;
      emit(
        "sleepStart",
        "Target sleep start",
        sleepStart,
        `Wake minus the ${settings.sleepTarget}-minute sleep target. This is planned sleep, not measured sleep.`,
      );
      if (finiteMinutes(settings.latency)) {
        const preferredSleep = beforeShift
          ? beforeShiftBedtime(
              beforeShift,
              wake,
              settings.sleepTarget,
              settings.latency,
            )
          : null;
        const bedtime =
          preferredSleep?.bedtime ?? sleepStart - settings.latency * MINUTE;
        if (preferredSleep) {
          conflicts.push(...preferredSleep.conflicts);
          const sleepEvent = events.find((e) => e.kind === "sleepStart")!;
          sleepEvent.at = preferredSleep.sleepStart;
          sleepEvent.why = `Bedtime plus ${settings.latency} minutes estimated latency leaves at least your ${settings.sleepTarget}-minute sleep target before waking. This is planned sleep, not measured sleep.`;
        }
        emit(
          "bedtime",
          "Planned bedtime",
          bedtime,
          beforeShift?.bedtime !== null && beforeShift?.bedtime !== undefined
            ? `Uses the previous-calendar-day bedtime preference before this ${entry.category.toLowerCase()} shift when it protects the full sleep target; an inadequate preference is flagged and the earlier required bedtime is used.`
            : `Target sleep start minus ${settings.latency} minutes estimated time to fall asleep.`,
        );
        if (
          entry.category === "Early" &&
          settings.earlyBed &&
          !beforeShift?.bedtimeClock
        ) {
          try {
            let usualBed = onDate(
              localDate,
              settings.earlyBed,
              entry.timezone,
              entry.disambiguation,
            );
            if (usualBed >= wake)
              usualBed = onDate(
                addDays(localDate, -1),
                settings.earlyBed,
                entry.timezone,
                entry.disambiguation,
              );
            const opportunity = Math.max(
              0,
              Math.floor((wake - usualBed) / MINUTE - settings.latency),
            );
            const bedtimeEvent = events.find((e) => e.kind === "bedtime")!;
            bedtimeEvent.why += ` Your usual early-shift bedtime ${settings.earlyBed} would provide up to ${opportunity} minutes estimated sleep opportunity after the entered latency; the calculated bedtime preserves your ${settings.sleepTarget}-minute target.`;
            if (opportunity < settings.sleepTarget)
              conflicts.push(
                `Your usual early-shift bedtime ${settings.earlyBed} allows only ${opportunity} minutes estimated sleep opportunity before the required wake, after ${settings.latency} minutes latency. The ${settings.sleepTarget}-minute target needs the earlier calculated bedtime; the target has not been shortened.`,
              );
          } catch (e) {
            missing.push(
              `Review usual early-shift bedtime or daylight-saving choice: ${errorText(e)}`,
            );
          }
        }
        if (finiteMinutes(settings.windDown))
          emit(
            "windDown",
            "Begin wind-down",
            bedtime - settings.windDown * MINUTE,
            `Planned bedtime minus ${settings.windDown} minutes wind-down.`,
          );
        if (settings.caffeine) {
          const interval =
            settings.caffeineBeforeBed === undefined
              ? 360
              : settings.caffeineBeforeBed;
          if (finiteMinutes(interval))
            emit(
              "caffeine",
              "Consider avoiding caffeine",
              bedtime - interval * MINUTE,
              `Optional reminder ${interval} minutes before planned bedtime. The starting interval is 360 minutes; this does not guarantee caffeine has stopped affecting you.`,
            );
          else
            missing.push(
              "Caffeine reminder interval needs a finite, non-negative number of minutes.",
            );
        }
      }
    }
  }
  const protectedStart =
    events.find((e) => e.kind === "windDown")?.at ??
    events.find((e) => e.kind === "bedtime")?.at;
  const protectedEnd = wake;
  let previous: { entry: RotaEntry; end: number } | null = null;
  for (const other of entries) {
    if (other.id === entry.id || other.status !== "Work") continue;
    try {
      if (!other.start) {
        if (other.date <= entry.date)
          missing.push(`Start time for duty on ${other.date} is missing.`);
        continue;
      }
      const otherStart = zonedEpoch(
        other.start,
        other.timezone,
        other.disambiguation,
      );
      const otherEnd = effectiveEnd(other);
      if (otherEnd === null) {
        if (otherStart < start)
          missing.push(`Finish time for duty on ${other.date} is missing.`);
        continue;
      }
      if (otherStart < start && (!previous || otherEnd > previous.end))
        previous = { entry: other, end: otherEnd };
      if (
        end !== null &&
        intersects(
          { start, end, label: "duty" },
          { start: otherStart, end: otherEnd, label: "duty" },
        )
      )
        conflicts.push(
          `Work overlaps duty ${other.duty || other.id} on ${other.date}.`,
        );
    } catch {
      missing.push(`Review date/time for duty on ${other.date}.`);
    }
  }
  if (previous && wake !== null) {
    if (
      [
        settings.returnMinutes,
        settings.postWorkMinutes,
        settings.windDown,
        settings.latency,
      ].every(finiteMinutes)
    ) {
      const readyForSleep =
        previous.end +
        (settings.returnMinutes! +
          settings.postWorkMinutes! +
          settings.windDown! +
          settings.latency!) *
          MINUTE;
      result.availableSleepMinutes = Math.max(
        0,
        Math.floor((wake - readyForSleep) / MINUTE),
      );
      if (
        finiteMinutes(settings.sleepTarget) &&
        result.availableSleepMinutes < settings.sleepTarget
      ) {
        conflicts.push(
          `Only ${result.availableSleepMinutes} minutes are available after the previous finish, return journey, post-work activities, wind-down and latency; the ${settings.sleepTarget}-minute sleep target cannot fit.`,
        );
      }
    }
    if (protectedStart !== undefined && previous.end > protectedStart)
      conflicts.push(
        "The previous duty runs into the planned sleep or wind-down period. The sleep target has not been shortened.",
      );
    else if (
      protectedStart !== undefined &&
      finiteMinutes(settings.returnMinutes) &&
      finiteMinutes(settings.postWorkMinutes) &&
      previous.end +
        (settings.returnMinutes + settings.postWorkMinutes) * MINUTE >
        protectedStart
    )
      conflicts.push(
        "Return travel and necessary post-work activities after the previous duty run into the planned sleep or wind-down period. The planned times and sleep target have not been changed.",
      );
  }
  {
    const intervals: Interval[] = [{ start, end: end ?? start, label: "work" }];
    if (departure !== null)
      intervals.push({
        start: departure,
        end: start,
        label: "outbound travel and arrival buffer",
      });
    if (prepare !== null && departure !== null)
      intervals.push({
        start: prepare,
        end: departure,
        label: "essential preparation",
      });
    if (protectedStart !== undefined && protectedEnd !== null)
      intervals.push({
        start: protectedStart,
        end: protectedEnd,
        label: "protected sleep or wind-down",
      });
    if (end !== null && finiteMinutes(settings.returnMinutes)) {
      const home = end + settings.returnMinutes * MINUTE;
      intervals.push({ start: end, end: home, label: "return travel" });
      if (finiteMinutes(settings.postWorkMinutes))
        intervals.push({
          start: home,
          end: home + settings.postWorkMinutes * MINUTE,
          label: "necessary post-work activities",
        });
    }
    const from = Math.min(start, prepare ?? start, protectedStart ?? start),
      until = Math.max(end ?? start, ...intervals.map((i) => i.end));
    for (const task of tasks.filter(
      (t) =>
        (t.kind === "fixed" || t.locked || !t.movable) &&
        !["completed", "skipped", "deferred"].includes(t.state),
    )) {
      try {
        for (const at of fixedOccurrences(
          task,
          settings.timezone,
          from - task.minutes * MINUTE,
          until + task.travelMinutes * MINUTE,
        )) {
          const occupied = {
            start: at - task.travelMinutes * MINUTE,
            end: at + task.minutes * MINUTE,
            label: task.title,
          };
          const overlap = intervals
            .filter((i) => intersects(i, occupied))
            .map((i) => i.label);
          if (overlap.length)
            conflicts.push(
              `Fixed commitment “${task.title}” overlaps ${overlap.join(", ")}.`,
            );
        }
      } catch {
        missing.push(`Review date/time for fixed commitment “${task.title}”.`);
      }
    }
  }
  result.missing = unique(missing);
  result.conflicts = unique(conflicts);
  result.provisional = result.missing.length > 0 || result.conflicts.length > 0;
  events.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
  return result;
}

export function nextWork(
  entries: RotaEntry[],
  clock: Clock,
  _timezone: string,
): RotaEntry | undefined {
  const now = clock.now();
  return entries
    .filter((e) => e.status === "Work" && !!e.start)
    .map((entry) => {
      try {
        return {
          entry,
          at: zonedEpoch(entry.start!, entry.timezone, entry.disambiguation),
        };
      } catch {
        return { entry, at: NaN };
      }
    })
    .filter((e) => Number.isFinite(e.at) && e.at >= now)
    .sort((a, b) => a.at - b.at || a.entry.id.localeCompare(b.entry.id))[0]
    ?.entry;
}

export function transitions(
  entries: RotaEntry[],
  settings: Settings,
  clock: Clock,
): Transition[] {
  const today = dateInZone(clock, settings.timezone),
    detailedUntil = addDays(today, 14);
  const work = entries
    .filter((e) => e.status === "Work")
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.start ?? "").localeCompare(b.start ?? ""),
    );
  const results: Transition[] = [];
  for (let i = 1; i < work.length; i++) {
    const from = work[i - 1],
      to = work[i];
    const returningFromHoliday = entries.some(
      (e) =>
        e.status === "Holiday" &&
        e.leaveApproval === "confirmed" &&
        e.date > from.date &&
        e.date < to.date,
    );
    if (
      (from.category === to.category && !returningFromHoliday) ||
      to.date < today
    )
      continue;
    const adjustmentDates: string[] = [],
      missing: string[] = [];
    if (from.timezone !== to.timezone || from.timezone !== settings.timezone)
      missing.push(
        "The transition duties and current sleep settings use different timezones; review them before using a precise transition timetable.",
      );
    for (
      let date = addDays(from.date, 1);
      date < to.date;
      date = addDays(date, 1)
    ) {
      const days = entries.filter((e) => e.date === date);
      if (
        days.some((e) => e.status === "Rest") &&
        !days.some((e) => e.status === "Work" || e.status === "Holiday")
      )
        adjustmentDates.push(date);
      else if (!days.length || days.some((e) => e.status === "Unknown"))
        missing.push(`Rota status on ${date} is unknown.`);
      if (
        days.some(
          (e) => e.status === "Holiday" && e.leaveApproval !== "confirmed",
        )
      )
        missing.push(`Leave on ${date} is requested, not confirmed.`);
    }
    const advice = [
      `The next ${to.category.toLowerCase()} pattern starts on ${to.date}.`,
      "Timing changes are planning heuristics and cannot measure or precisely reset your body clock.",
    ];
    if (returningFromHoliday)
      advice.push(
        "This return from confirmed holiday uses the recorded next duty. Review work times, travel and essential preparation, and protect sleep before returning; holiday is distinct from a confirmed rest day.",
      );
    const transition: Transition = {
      id: `${from.id}:${to.id}`,
      from: from.category,
      to: to.category,
      nextDate: to.date,
      adjustmentDates,
      advice,
      missing,
      provisional: true,
    };
    let planConflict = false;
    if (from.category === "Night" || to.category === "Night") {
      missing.push(
        "Specialist overnight-shift coaching has not been implemented or reviewed.",
      );
      advice.push(
        "Record overnight duties using separate start and finish dates; personalised night-shift coaching is withheld.",
      );
    } else if (from.category === to.category && returningFromHoliday) {
      const returnPlan = planShift(to, settings, entries);
      missing.push(...returnPlan.missing);
      advice.push(...returnPlan.conflicts);
      planConflict = returnPlan.conflicts.length > 0;
      advice.push(
        "Use the normal plan for this recorded shift category after checking your current preferences and commitments. No extra adjustment timetable is inferred from holiday.",
      );
    } else if (from.category === "Late" && to.category === "Early") {
      advice.push(
        "Protect recovery after the last late finish. Move lunch preparation, ironing and shopping earlier on available days; do not force an unusually early wake immediately after the late duty.",
      );
      addDurationMissing(
        settings,
        [
          "returnMinutes",
          "postWorkMinutes",
          "sleepTarget",
          "latency",
          "windDown",
        ],
        missing,
      );
      if (!settings.lateBed)
        missing.push("Usual late-shift bedtime is still needed.");
      if (!settings.lateWake)
        missing.push("Usual late-shift wake time is still needed.");
      if (!settings.timezoneConfirmed)
        missing.push("Confirm the rota timezone.");
      const target = planShift(to, settings, entries);
      missing.push(...target.missing);
      planConflict = target.conflicts.length > 0;
      const targetWake = target.events.find((e) => e.kind === "wake")?.at;
      if (targetWake === undefined)
        missing.push(
          "Early-shift preparation and wake inputs are still needed.",
        );
      if (target.conflicts.length) advice.push(...target.conflicts);
      let lastEnd: number | null = null;
      try {
        lastEnd = effectiveEnd(from);
      } catch {
        missing.push(
          "Review the final late finish and daylight-saving choice.",
        );
      }
      if (lastEnd === null)
        missing.push("Final late-shift finish is still needed.");
      if (
        !missing.length &&
        to.date <= detailedUntil &&
        targetWake !== undefined &&
        lastEnd !== null
      ) {
        const steps: NonNullable<Transition["dailySteps"]> = [];
        try {
          const firstDate = addDays(from.date, 1);
          const preferredBed = preferredBedAfter(
            lastEnd,
            settings.lateBed!,
            settings.timezone,
          );
          const readyBed =
            lastEnd +
            (settings.returnMinutes! +
              settings.postWorkMinutes! +
              settings.windDown!) *
              MINUTE;
          const recoveryWake =
            Math.max(readyBed, preferredBed) +
            (settings.latency! + settings.sleepTarget!) * MINUTE;
          let previousWakeTime: string | null = null;
          for (const date of adjustmentDates) {
            const preferredWake = onDate(
              date,
              previousWakeTime ?? settings.lateWake!,
              settings.timezone,
            );
            const targetTime = localAt(targetWake, to.timezone).slice(11, 16);
            const desired = onDate(date, targetTime, settings.timezone);
            const wake =
              date === firstDate
                ? Math.max(preferredWake, recoveryWake)
                : Math.max(desired, preferredWake - 30 * MINUTE);
            const bedtime =
              wake - (settings.sleepTarget! + settings.latency!) * MINUTE;
            steps.push({
              date,
              bedtime: localAt(bedtime, settings.timezone),
              wake: localAt(wake, settings.timezone),
              why:
                date === firstDate
                  ? "Protect a full sleep target after return travel and post-work recovery; do not advance this first wake."
                  : "Try moving waking and bedtime up to 30 minutes earlier on this confirmed rest day while preserving the full sleep target.",
            });
            previousWakeTime = localAt(wake, settings.timezone).slice(11, 16);
          }
          transition.dailySteps = steps;
          advice.push(
            "The 30-minute daily advance is an editable planning heuristic. A short gap may not reach your early-shift wake preference; review conflicts rather than reducing sleep.",
          );
        } catch (e) {
          missing.push(
            `Review transition time or daylight-saving choice: ${errorText(e)}`,
          );
        }
      }
    } else if (from.category === "Early" && to.category === "Late") {
      advice.push(
        settings.consistentWake
          ? "Keep a relatively consistent wake time where it fits; a later work start does not require a late bedtime."
          : "Use your entered late-shift preferences without pushing sleep as late as possible.",
      );
      if (!settings.lateWake && !settings.restWake)
        missing.push("Usual late-shift or rest-day wake time is still needed.");
    } else
      advice.push(
        "Review sleep preferences and commitments before this pattern change; move essential chores ahead of wind-down.",
      );
    if (to.date > detailedUntil)
      advice.push(
        "This date is outside the 14-day detailed horizon. Check it again nearer the duty.",
      );
    transition.missing = unique(missing);
    transition.provisional =
      transition.missing.length > 0 ||
      planConflict ||
      to.date > detailedUntil ||
      from.category === "Night" ||
      to.category === "Night" ||
      advice.some((a) => a.includes("cannot fit") || a.includes("runs into"));
    results.push(transition);
  }
  return results;
}

/** Local/offline greedy placement; never modifies user commitments or sleep targets. */
export function planTasks(
  tasks: Task[],
  entries: RotaEntry[],
  settings: Settings,
  clock: Clock,
  horizonDays = 14,
  preparationContext?: PreparationTaskContext,
): TaskPlacement[] {
  const now = clock.now(),
    snapshotClock: Clock = { now: () => now },
    nowMinute = Math.ceil(now / MINUTE) * MINUTE;
  const today = dateInZone(snapshotClock, settings.timezone),
    lastDate = addDays(today, Math.max(1, Math.min(366, horizonDays)));
  const horizonEnd = onDate(lastDate, "00:00", settings.timezone);
  let provisionalPreparationDate: string | undefined;
  if (preparationContext && (!settings.restWake || !settings.restBed)) {
    const selectedShift = entries.find(
      (e) => e.id === preparationContext.beforeShiftId && e.status === "Work",
    );
    if (selectedShift?.timezone === settings.timezone) {
      try {
        const bounds = workBounds(selectedShift);
        if (bounds) {
          const preferences = beforeShiftSleepPreferences(
              selectedShift,
              settings,
              bounds.start,
            ),
            selectedPlan = planShift(selectedShift, settings, entries, tasks),
            wind = selectedPlan.events.find((e) => e.kind === "windDown")?.at;
          if (
            preferences !== null &&
            !preferences.missing.length &&
            selectedPlan.events.some((e) => e.kind === "wake") &&
            selectedPlan.events.some((e) => e.kind === "bedtime") &&
            wind !== undefined &&
            localAt(wind, settings.timezone).slice(0, 10) ===
              preferences.preparationDate
          )
            provisionalPreparationDate = preferences.preparationDate;
        }
      } catch {
        /* Invalid or ambiguous preferences remain unconfirmed. */
      }
    }
  }
  const busy: Interval[] = [],
    uncertain = new Map<string, string[]>(),
    result: TaskPlacement[] = [];
  const block = (start: number, end: number, label: string) => {
    if (end > start) busy.push({ start, end, label });
  };
  const unclear = (date: string, text: string) =>
    uncertain.set(date, unique([...(uncertain.get(date) ?? []), text]));
  const prep = essentialPreparation(settings);
  const work = entries.filter((e) => e.status === "Work");
  for (const entry of work) {
    let bounds: ReturnType<typeof workBounds>;
    try {
      bounds = workBounds(entry);
    } catch (e) {
      unclear(entry.date, `Duty time needs review: ${errorText(e)}`);
      continue;
    }
    if (!bounds) {
      unclear(entry.date, "Work start or finish is missing.");
      continue;
    }
    const outbound =
      finiteMinutes(settings.outboundMax) &&
      finiteMinutes(settings.arrivalBuffer)
        ? (settings.outboundMax + settings.arrivalBuffer) * MINUTE
        : 0;
    const returning = finiteMinutes(settings.returnMinutes)
      ? settings.returnMinutes * MINUTE
      : 0;
    block(bounds.start - outbound, bounds.end + returning, "work and travel");
    if (
      !finiteMinutes(settings.outboundMax) ||
      !finiteMinutes(settings.arrivalBuffer) ||
      !finiteMinutes(settings.returnMinutes)
    )
      unclear(
        entry.date,
        "Commute and arrival inputs are needed to protect travel.",
      );
    if (prep.minutes !== null)
      block(
        bounds.start - outbound - prep.minutes * MINUTE,
        bounds.start - outbound,
        "essential preparation",
      );
    if (prep.missing.length) unclear(entry.date, prep.missing.join(" "));
    const plan = planShift(entry, settings, entries, tasks);
    if (!settings.timezoneConfirmed)
      unclear(entry.date, "Confirm the rota timezone.");
    if (entry.timezone !== settings.timezone) {
      unclear(
        entry.date,
        "Recorded duty and current routine settings use different timezones; review the sleep plan.",
      );
      unclear(
        addDays(entry.date, -1),
        "The next recorded duty uses a different timezone from current routine settings.",
      );
    }
    if (
      !validSleepTarget(settings.sleepTarget) ||
      ![
        settings.postWorkMinutes,
        settings.sleepTarget,
        settings.latency,
        settings.windDown,
      ].every(finiteMinutes)
    )
      unclear(
        entry.date,
        "Post-work activity and sleep durations are needed before assigning tasks.",
      );
    const sleep =
      plan.events.find((e) => e.kind === "windDown")?.at ??
      plan.events.find((e) => e.kind === "bedtime")?.at;
    const wake = plan.events.find((e) => e.kind === "wake")?.at;
    if (sleep !== undefined && wake !== undefined)
      block(sleep, wake, "sleep and wind-down");
    else {
      unclear(
        entry.date,
        "Sleep and wake inputs are needed before scheduling around this duty.",
      );
      unclear(
        addDays(entry.date, -1),
        "Next duty sleep and wake inputs are missing.",
      );
    }
    if (
      entry.category === "Late" ||
      entry.category === "Night" ||
      localAt(bounds.end, entry.timezone).slice(0, 10) > entry.date
    ) {
      const recoveryDate = localAt(bounds.end, entry.timezone).slice(0, 10);
      if (
        validSleepTarget(settings.sleepTarget) &&
        [
          settings.returnMinutes,
          settings.postWorkMinutes,
          settings.windDown,
          settings.latency,
          settings.sleepTarget,
        ].every(finiteMinutes)
      ) {
        let bed =
          bounds.end +
          (settings.returnMinutes! +
            settings.postWorkMinutes! +
            settings.windDown!) *
            MINUTE;
        if (entry.category === "Late") {
          if (!settings.lateBed || !settings.lateWake) {
            unclear(
              recoveryDate,
              "Usual late-shift bedtime and wake time are needed to protect post-late recovery.",
            );
            unclear(
              addDays(recoveryDate, 1),
              "The preceding late duty needs usual bedtime and wake inputs.",
            );
          } else {
            try {
              bed = Math.max(
                bed,
                preferredBedAfter(bounds.end, settings.lateBed, entry.timezone),
              );
            } catch {
              unclear(
                addDays(recoveryDate, 1),
                "Review post-late bedtime and daylight-saving choice.",
              );
            }
          }
        }
        let recoveryEnd =
          bed + (settings.latency! + settings.sleepTarget!) * MINUTE;
        if (entry.category === "Late" && settings.lateWake) {
          try {
            const recoveryWakeDate = localAt(recoveryEnd, entry.timezone).slice(
              0,
              10,
            );
            recoveryEnd = Math.max(
              recoveryEnd,
              onDate(recoveryWakeDate, settings.lateWake, entry.timezone),
            );
          } catch {
            unclear(
              addDays(recoveryDate, 1),
              "Review post-late wake time and daylight-saving choice.",
            );
          }
        }
        const home = bounds.end + settings.returnMinutes! * MINUTE;
        block(
          home,
          home + settings.postWorkMinutes! * MINUTE,
          "necessary post-work recovery activities",
        );
        block(
          bed - settings.windDown! * MINUTE,
          recoveryEnd,
          "post-duty recovery and full sleep target",
        );
      } else {
        unclear(
          recoveryDate,
          "Return travel and post-duty recovery/sleep durations are missing.",
        );
        unclear(
          addDays(recoveryDate, 1),
          "The preceding late or overnight duty needs recovery inputs.",
        );
      }
    } else if (finiteMinutes(settings.postWorkMinutes))
      block(
        bounds.end + returning,
        bounds.end + returning + settings.postWorkMinutes * MINUTE,
        "necessary post-work activities",
      );
  }
  for (
    let date = addDays(today, -1);
    date <= lastDate;
    date = addDays(date, 1)
  ) {
    const dayEntries = entries.filter((e) => e.date === date);
    const nonWork = !dayEntries.some((e) => e.status === "Work");
    if (
      dayEntries.some(
        (e) => e.status === "Holiday" && e.leaveApproval !== "confirmed",
      )
    )
      unclear(
        date,
        "Requested holiday is not confirmed availability; review your official rota before assigning flexible tasks.",
      );
    const unconfirmed: string[] = [];
    addDurationMissing(
      settings,
      [
        "outboundMax",
        "arrivalBuffer",
        "returnMinutes",
        "postWorkMinutes",
        "sleepTarget",
        "latency",
        "windDown",
      ],
      unconfirmed,
    );
    const suggestions = unconfirmed.filter((m) =>
      m.startsWith("Confirm the suggested"),
    );
    if (suggestions.length) unclear(date, suggestions.join(" "));
    if (!validSleepTarget(settings.sleepTarget))
      unclear(
        date,
        "Enter a positive sleep target before assigning flexible tasks; planned sleep must stay protected.",
      );
    if (!nonWork) continue;
    if (!dayEntries.length || dayEntries.some((e) => e.status === "Unknown"))
      unclear(
        date,
        "Rota status is unknown; confirm availability before assigning tasks.",
      );
    if (!settings.timezoneConfirmed)
      unclear(date, "Confirm the rota timezone.");
    if (
      !settings.restWake ||
      !settings.restBed ||
      !validSleepTarget(settings.sleepTarget) ||
      ![settings.sleepTarget, settings.latency, settings.windDown].every(
        finiteMinutes,
      )
    ) {
      // A selected explicit pre-shift pair protects this coming night's sleep.
      // Only the preparation caller may propose reviewable evening gaps while
      // ordinary previous-night waking remains unknown; no rest time is invented.
      if (date === provisionalPreparationDate) continue;
      unclear(
        date,
        "Rest/leave-day bedtime, wake time and sleep durations are needed to protect sleep.",
      );
      continue;
    }
    try {
      const wake = onDate(date, settings.restWake, settings.timezone);
      let bed = onDate(date, settings.restBed, settings.timezone);
      if (bed >= wake)
        bed = onDate(addDays(date, -1), settings.restBed, settings.timezone);
      const requiredBed =
        wake - (settings.sleepTarget! + settings.latency!) * MINUTE;
      block(
        Math.min(bed, requiredBed) - settings.windDown! * MINUTE,
        wake,
        "rest/leave sleep and wind-down",
      );
      if (
        dayEntries.some((e) => e.status === "Rest") &&
        finiteMinutes(settings.freeMinutes) &&
        settings.freeMinutes > 0
      ) {
        // The preferred afternoon reserve is visible in placement explanations.
        const freeStart = onDate(date, "16:00", settings.timezone);
        block(
          freeStart,
          freeStart + settings.freeMinutes * MINUTE,
          "protected rest-day personal time",
        );
      }
    } catch (e) {
      unclear(date, `Rest-day sleep time needs review: ${errorText(e)}`);
    }
  }
  // Detailed transition sleep estimates are protected as well as the usual
  // rest-day routine; a later gradual wake must not become a chore slot.
  for (const transition of transitions(entries, settings, snapshotClock)) {
    for (const step of transition.dailySteps ?? []) {
      try {
        const bed = zonedEpoch(step.bedtime, settings.timezone),
          wake = zonedEpoch(step.wake, settings.timezone);
        block(
          bed -
            (finiteMinutes(settings.windDown) ? settings.windDown : 0) * MINUTE,
          wake,
          "transition sleep and wind-down",
        );
      } catch {
        unclear(step.date, "Transition sleep time needs review.");
      }
    }
  }
  // Unknown availability blocks the complete local day, including a task window
  // that crosses midnight from a preceding date.
  uncertain.forEach((reasons, date) => {
    try {
      block(
        onDate(date, "00:00", settings.timezone),
        onDate(addDays(date, 1), "00:00", settings.timezone),
        `unconfirmed availability: ${reasons.join(" ")}`,
      );
    } catch {
      /* Invalid work dates already have a visible review reason. */
    }
  });
  const selected = [...new Map(tasks.map((t) => [t.id, t])).values()];
  const prerequisites = new Map(
    selected.map((task) => [task.id, preparationPrerequisites(task, selected)]),
  );
  const active = selected.filter(
    (t) => !["completed", "skipped", "deferred"].includes(t.state),
  );
  const fixed = active.filter(
    (t) => t.kind === "fixed" || t.locked || !t.movable,
  );
  const rankedFlexible = active
    .filter((t) => !fixed.includes(t))
    .sort((a, b) => {
      const rank = { essential: 0, flexible: 1, optional: 2, fixed: -1 };
      return (
        rank[a.kind] - rank[b.kind] ||
        b.priority - a.priority ||
        a.deadline.localeCompare(b.deadline) ||
        a.id.localeCompare(b.id)
      );
    });
  // Priority still orders independent work. A selected prerequisite must be
  // allocated before its dependant even when the dependant has higher priority.
  const flexible: Task[] = [],
    visited = new Set<string>();
  const visit = (task: Task) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const before of prerequisites.get(task.id) ?? [])
      if (rankedFlexible.includes(before)) visit(before);
    flexible.push(task);
  };
  rankedFlexible.forEach(visit);
  const selectedRoutines = orderedPreparationRoutines(settings);
  const routineDependency = (task: Task, occurrence: string | undefined) => {
    const kind = preparationActivityKind(task.title),
      required =
        kind === "ironing"
          ? "laundry"
          : kind === "packing"
            ? "lunch"
            : undefined;
    if (
      !required ||
      !selectedRoutines.some((r) => routinePreparationKind(r) === required)
    )
      return undefined;
    const entry = task.linkedShiftId
      ? entries.find((e) => e.id === task.linkedShiftId && e.status === "Work")
      : nextWork(entries, snapshotClock, settings.timezone);
    if (!entry) return undefined;
    // Day-before preparation can use its own saved prerequisite. A separate
    // shift-day routine still belongs to Shift Plan and must not move this pair
    // into the morning of the duty.
    try {
      const shiftDate = localAt(
        zonedEpoch(entry.start!, entry.timezone, entry.disambiguation),
        entry.timezone,
      ).slice(0, 10);
      const preparationStart = onDate(
        addDays(shiftDate, -1),
        "00:00",
        entry.timezone,
      );
      const preparationEnd = onDate(shiftDate, "00:00", entry.timezone);
      const inPreparationDay = (value: Task) =>
        zonedEpoch(value.earliest, settings.timezone) >= preparationStart &&
        zonedEpoch(value.deadline, settings.timezone) <= preparationEnd;
      if (
        inPreparationDay(task) &&
        (prerequisites.get(task.id) ?? []).some(
          (before) =>
            preparationActivityKind(before.title) === required &&
            inPreparationDay(before),
        )
      )
        return undefined;
    } catch {
      /* Invalid bounds are handled by the normal task validation. */
    }
    if (
      !task.linkedShiftId &&
      (entry.date < task.earliest.slice(0, 10) ||
        entry.date > addDays(task.deadline.slice(0, 10), 1))
    )
      return undefined;
    if (
      occurrence &&
      occurrence !== entry.date &&
      occurrence !== addDays(entry.date, -1)
    )
      return undefined;
    const shift = planShift(entry, settings, entries);
    const prepare = shift.events.find((e) => e.kind === "prepare")?.at;
    const requiredRoutines = selectedRoutines.filter(
      (r) => routinePreparationKind(r) === required,
    );
    const labels = requiredRoutines.map((r) => `“${r.name}”`).join(" and ");
    if (prepare === undefined || prep.minutes === null)
      return { end: null, labels };
    let cursor = prepare,
      end = prepare;
    for (const routine of selectedRoutines) {
      cursor += routine.minutes! * MINUTE;
      if (routinePreparationKind(routine) === required) end = cursor;
    }
    return { end, labels };
  };
  const dependencyReady = (
    task: Task,
    occurrence: string | undefined,
    until: number,
  ) => {
    let notBefore = nowMinute;
    const reasons: string[] = [];
    for (const before of prerequisites.get(task.id) ?? []) {
      const occurrenceDay = occurrence ?? task.earliest.slice(0, 10);
      const state =
        inactiveOccurrence(before, occurrenceDay) &&
        !["completed", "skipped", "deferred"].includes(before.state)
          ? before.occurrenceStates![occurrenceDay]
          : before.state;
      if (state === "completed") continue;
      if (state === "skipped" || state === "deferred") {
        reasons.push(
          `“${before.title}” is ${state}; complete it or review the dependency before “${task.title}”.`,
        );
        continue;
      }
      const candidates = result.filter(
        (p) =>
          p.taskId === before.id &&
          (before.recurrence === "none" || p.occurrenceDate === occurrenceDay),
      );
      const usable = candidates
        .filter((p) => p.end !== null && p.end <= until && !p.conflict)
        .sort((a, b) => a.end! - b.end!)[0];
      if (!usable) {
        reasons.push(
          `“${before.title}” must finish before “${task.title}”; move or defer the dependent activity while its prerequisite has no safe permitted slot.`,
        );
      } else notBefore = Math.max(notBefore, usable.end!);
    }
    const routine = routineDependency(task, occurrence);
    if (routine) {
      if (routine.end === null || routine.end > until)
        reasons.push(
          `${routine.labels} must finish before “${task.title}”; review the selected routine's duration or move/defer the dependent task instead of scheduling it first.`,
        );
      else notBefore = Math.max(notBefore, routine.end);
    }
    return { notBefore, reasons, routine };
  };
  for (const task of [...fixed, ...flexible]) {
    if (
      !finiteMinutes(task.minutes) ||
      task.minutes === 0 ||
      !finiteMinutes(task.travelMinutes)
    ) {
      result.push({
        taskId: task.id,
        start: null,
        end: null,
        reason:
          "Enter a positive task duration and a non-negative travel allowance.",
      });
      continue;
    }
    let earliest: number, deadline: number;
    try {
      earliest = zonedEpoch(task.earliest, settings.timezone);
      deadline = zonedEpoch(task.deadline, settings.timezone);
    } catch (e) {
      result.push({
        taskId: task.id,
        start: null,
        end: null,
        reason: `Review task date/time or daylight-saving choice: ${errorText(e)}`,
      });
      continue;
    }
    if (deadline < earliest) {
      result.push({
        taskId: task.id,
        start: null,
        end: null,
        reason: "Deadline precedes the earliest permitted time.",
      });
      continue;
    }
    let linkedDeadline = deadline;
    if (task.linkedShiftId) {
      const linked = entries.find(
        (e) => e.id === task.linkedShiftId && e.status === "Work",
      );
      if (!linked) {
        result.push({
          taskId: task.id,
          start: null,
          end: null,
          reason:
            "The linked duty is no longer a workday; review this preparation task.",
        });
        continue;
      }
      const linkedPlan = planShift(linked, settings, entries);
      const departure = linkedPlan.events.find(
        (e) => e.kind === "departure",
      )?.at;
      if (departure === undefined) {
        result.push({
          taskId: task.id,
          start: null,
          end: null,
          reason: "Departure inputs for the linked duty are missing.",
        });
        continue;
      }
      linkedDeadline = Math.min(linkedDeadline, departure);
    }
    if (!fixed.includes(task) && linkedDeadline <= nowMinute) {
      result.push({
        taskId: task.id,
        start: null,
        end: null,
        reason:
          "The deadline has passed. Review or extend it before looking for another permitted slot; sleep remains protected.",
      });
      continue;
    }
    let first = localAt(earliest, settings.timezone).slice(0, 10);
    if (
      fixed.includes(task) &&
      task.recurrence !== "none" &&
      task.scheduledStart
    ) {
      try {
        first = localAt(
          zonedEpoch(task.scheduledStart, settings.timezone),
          settings.timezone,
        ).slice(0, 10);
      } catch (e) {
        result.push({
          taskId: task.id,
          start: null,
          end: null,
          reason: `Review fixed appointment time: ${errorText(e)}`,
        });
        continue;
      }
    }
    const last = localAt(
      Math.min(linkedDeadline, horizonEnd - 1),
      settings.timezone,
    ).slice(0, 10);
    const dates: string[] = [];
    if (task.recurrence === "none") dates.push(first);
    else
      for (
        let date = first;
        date <= last;
        date = addDays(date, task.recurrence === "daily" ? 1 : 7)
      )
        if (date >= today) dates.push(date);
    for (const occurrence of dates) {
      const recurring = task.recurrence !== "none";
      if (recurring && inactiveOccurrence(task, occurrence)) continue;
      const occurrenceStart = recurring
        ? Math.max(earliest, onDate(occurrence, "00:00", settings.timezone))
        : earliest;
      const occurrenceEnd = recurring
        ? Math.min(
            linkedDeadline,
            onDate(addDays(occurrence, 1), "00:00", settings.timezone),
          )
        : linkedDeadline;
      const base = {
        taskId: task.id,
        ...(recurring ? { occurrenceDate: occurrence } : {}),
      };
      if (fixed.includes(task)) {
        try {
          const chosen = recurring
            ? onDate(
                occurrence,
                (task.scheduledStart ?? task.earliest).slice(11, 16),
                settings.timezone,
              )
            : task.scheduledStart
              ? zonedEpoch(task.scheduledStart, settings.timezone)
              : occurrenceStart;
          const end = chosen + task.minutes * MINUTE;
          const occupied = {
            start: chosen - task.travelMinutes * MINUTE,
            end,
            label: task.title,
          };
          const overlaps = busy.filter((b) => intersects(b, occupied));
          const reasons = overlaps.map((b) => b.label);
          const day = localAt(chosen, settings.timezone).slice(0, 10);
          if (uncertain.has(day)) reasons.push(...uncertain.get(day)!);
          if (chosen < occurrenceStart || end > occurrenceEnd)
            reasons.push("outside the permitted deadline");
          result.push({
            ...base,
            start: chosen,
            end,
            reason:
              "Fixed or locked commitment retained at its entered time. Travel allowance is reserved before it.",
            ...(reasons.length
              ? {
                  conflict: `Review conflict with ${unique(reasons).join("; ")}.`,
                }
              : {}),
          });
          block(
            occupied.start,
            occupied.end,
            `fixed commitment: ${task.title}`,
          );
        } catch (e) {
          result.push({
            ...base,
            start: null,
            end: null,
            reason: `Review fixed appointment time: ${errorText(e)}`,
          });
        }
        continue;
      }
      let upper = Math.min(occurrenceEnd, horizonEnd);
      if (
        provisionalPreparationDate &&
        task.linkedShiftId === preparationContext?.beforeShiftId
      ) {
        // Leave room for selected dependent activities after this prerequisite
        // when packing or ironing is allocated near the bedtime routine.
        const descendants = new Set<string>();
        const reserve = (value: Task): number => {
          let total = 0;
          for (const other of flexible) {
            if (
              descendants.has(other.id) ||
              !other.preparationAutoStart ||
              other.linkedShiftId !== task.linkedShiftId ||
              !(prerequisites.get(other.id) ?? []).some(
                (before) => before.id === value.id,
              )
            )
              continue;
            descendants.add(other.id);
            total += other.minutes + other.travelMinutes + reserve(other);
          }
          return total;
        };
        upper -= reserve(task) * MINUTE;
      }
      // A booked dependant cannot move. Its prerequisite must fit before the
      // appointment's reserved travel, or the fixed row will show a conflict.
      for (const dependant of fixed.filter((other) =>
        (prerequisites.get(other.id) ?? []).some((p) => p.id === task.id),
      )) {
        const booked = result.filter(
          (p) =>
            p.taskId === dependant.id &&
            p.start !== null &&
            (!recurring ||
              dependant.recurrence === "none" ||
              p.occurrenceDate === occurrence),
        );
        for (const p of booked)
          upper = Math.min(upper, p.start! - dependant.travelMinutes * MINUTE);
      }
      const dependency = dependencyReady(
        task,
        recurring ? occurrence : undefined,
        upper,
      );
      if (dependency.reasons.length) {
        result.push({
          ...base,
          start: null,
          end: null,
          reason: dependency.reasons.join(" "),
        });
        continue;
      }
      const lower = Math.max(nowMinute, occurrenceStart, dependency.notBefore);
      const parts: { start: number; end: number }[] = [];
      let remaining = task.minutes;
      let noSlotReason =
        "No permitted slot fits without reducing sleep, displacing work or taking protected personal time.";
      if (dependency.routine)
        noSlotReason += ` ${dependency.routine.labels} must finish first; move or defer “${task.title}” if it cannot fit afterwards.`;
      for (
        let date = localAt(lower, settings.timezone).slice(0, 10);
        date <=
          localAt(Math.max(lower, upper), settings.timezone).slice(0, 10) &&
        remaining > 0;
        date = addDays(date, 1)
      ) {
        if (
          date === provisionalPreparationDate &&
          task.linkedShiftId !== preparationContext?.beforeShiftId
        ) {
          noSlotReason =
            "Rest/leave-day bedtime and wake inputs are still needed for this task; the provisional pre-shift availability applies only to preparation tasks linked to the selected duty.";
          continue;
        }
        if (uncertain.has(date)) {
          noSlotReason = `Plan remains provisional: ${uncertain.get(date)!.join(" ")}`;
          continue;
        }
        let winStart: number, winEnd: number;
        try {
          winStart = onDate(date, task.windowStart, settings.timezone);
          winEnd = onDate(date, task.windowEnd, settings.timezone);
          if (winEnd <= winStart)
            winEnd = onDate(
              addDays(date, 1),
              task.windowEnd,
              settings.timezone,
            );
        } catch (e) {
          noSlotReason = `Review preferred window or daylight-saving choice: ${errorText(e)}`;
          continue;
        }
        let cursor = Math.max(lower, winStart),
          limit = Math.min(upper, winEnd);
        const occupied = busy
          .filter((b) => b.end > cursor && b.start < limit)
          .sort((a, b) => a.start - b.start || a.end - b.end);
        const gaps: { start: number; end: number }[] = [];
        for (const b of occupied) {
          if (b.start > cursor)
            gaps.push({ start: cursor, end: Math.min(b.start, limit) });
          cursor = Math.max(cursor, b.end);
        }
        if (cursor < limit) gaps.push({ start: cursor, end: limit });
        const latestPreparationGap =
          date === provisionalPreparationDate &&
          task.linkedShiftId === preparationContext?.beforeShiftId;
        for (const gap of latestPreparationGap ? [...gaps].reverse() : gaps) {
          const capacity =
            Math.floor((gap.end - gap.start) / MINUTE) - task.travelMinutes;
          if (capacity <= 0 || (!task.splittable && capacity < remaining))
            continue;
          const minutes = task.splittable
            ? Math.min(capacity, remaining)
            : remaining;
          const start = latestPreparationGap
              ? gap.end - minutes * MINUTE
              : gap.start + task.travelMinutes * MINUTE,
            end = start + minutes * MINUTE;
          parts.push({ start, end });
          remaining -= minutes;
          if (!remaining) break;
        }
      }
      if (remaining > 0)
        result.push({ ...base, start: null, end: null, reason: noSlotReason });
      else {
        parts.sort((a, b) => a.start - b.start || a.end - b.end);
        parts.forEach((p) =>
          block(
            p.start - task.travelMinutes * MINUTE,
            p.end,
            `task: ${task.title}`,
          ),
        );
        result.push({
          ...base,
          start: parts[0].start,
          end: parts[parts.length - 1].end,
          reason:
            "Fits your entered window and deadline, around work/travel, fixed commitments, essential preparation, full planned sleep and protected rest-day personal time.",
          ...(parts.length > 1 ? { parts } : {}),
        });
      }
    }
  }
  // Fixed commitments are retained even when their prerequisites cannot fit;
  // they receive a visible conflict rather than an invented replacement time.
  for (const placement of result) {
    const task = fixed.find((t) => t.id === placement.taskId);
    if (!task || placement.start === null) continue;
    const dependency = dependencyReady(
      task,
      placement.occurrenceDate,
      placement.start - task.travelMinutes * MINUTE,
    );
    if (dependency.reasons.length)
      placement.conflict = unique([
        ...(placement.conflict ? [placement.conflict] : []),
        ...dependency.reasons,
      ]).join(" ");
  }
  return result;
}
