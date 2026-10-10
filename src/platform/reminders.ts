import {
  AppState,
  Clock,
  ReminderRecord,
  RotaEntry,
  Settings,
  Task,
} from "../model";
import { planShift, transitions, workBounds } from "../engine/planner";
import { panelRollover } from "../engine/panelRollover";
import {
  planPreparation,
  PreparationPlan,
  PreparationRow,
} from "../engine/preparation";
import { shiftDayPanels } from "../engine/shiftDayPanels";
import {
  addDays,
  dateInZone,
  displayDate,
  localAt,
  MINUTE,
  onDate,
  zonedEpoch,
} from "../engine/time";

export const REMINDER_PREFIX = "wakey:";
export const REMINDER_HORIZON_DAYS = 14;
export const MAX_REMINDERS = 60;
export const MAX_WEB_REMINDERS = 1000;
const DAY = 86_400_000;
const sleepKinds = new Set([
  "windDown",
  "bedtime",
  "sleepStart",
  "wake",
  "caffeine",
]);
const supportedKinds = new Set([
  "prepare",
  "windDown",
  "bedtime",
  "wake",
  "departure",
  "appointment",
  "transition",
  "caffeine",
  "activity",
  "task",
]);
const inactive = (state: string) =>
  ["completed", "skipped", "deferred", "conflict", "needs-input"].includes(
    state,
  );
function boundedReminderId(id: string): string {
  if (id.length <= 200) return id;
  let hash = 14695981039346656037n;
  for (const character of id) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n,
    );
  }
  return `wakey:long:${hash.toString(16).padStart(16, "0")}`;
}

/** A recorded event keeps its specific kind; this chooses its settings switch. */
export function reminderKindSetting(kind: string): string {
  return supportedKinds.has(kind) ? kind : "activity";
}

/** Upgrade only an already opted-in legacy profile, preserving old switches.
 * Version 1 makes an intentional activity/task opt-out distinguishable from a
 * profile saved before those notification types existed. */
export function upgradeReminderCoverage(settings: Settings): Settings {
  if (!settings.remindersEnabled || settings.reminderCoverageVersion === 1)
    return settings;
  return {
    ...settings,
    reminderCoverageVersion: 1,
    reminderKinds: [
      ...new Set([...settings.reminderKinds, "activity", "task"]),
    ],
  };
}

/** Deterministic due alerts for the dated activities displayed by the panels.
 * Calendar sampling uses the same independent references as Today, so a duty
 * remains eligible after work starts and a new shift block owns its day-before
 * routine. No task, placement, setting or saved planner record is changed.
 */
export function desiredReminders(
  state: AppState,
  clock: Clock,
  options: { max?: number; horizonDays?: number } = {},
): ReminderRecord[] {
  const settings = upgradeReminderCoverage(state.settings);
  if (
    !settings.remindersEnabled ||
    !settings.onboardingComplete ||
    !settings.timezoneConfirmed
  )
    return [];
  const horizonDays = Number.isFinite(options.horizonDays)
    ? Math.max(
        1,
        Math.min(REMINDER_HORIZON_DAYS, Math.floor(options.horizonDays!)),
      )
    : REMINDER_HORIZON_DAYS;
  const now = clock.now(),
    through = now + horizonDays * DAY;
  const firstDate = dateInZone({ now: () => now }, settings.timezone),
    lastDate = addDays(
      dateInZone({ now: () => through }, settings.timezone),
      2,
    ),
    planningLastDate = addDays(
      dateInZone(
        { now: () => now + REMINDER_HORIZON_DAYS * DAY },
        settings.timezone,
      ),
      2,
    );
  const enabled = new Set(
    settings.reminderKinds.filter((kind) => supportedKinds.has(kind)),
  );
  const result = new Map<string, ReminderRecord>();
  const add = (record: ReminderRecord) => {
    if (
      enabled.has(reminderKindSetting(record.kind)) &&
      Number.isFinite(record.at) &&
      record.at > now &&
      record.at <= through
    )
      result.set(boundedReminderId(record.id), {
        ...record,
        // Push payloads have a small byte limit; both platforms use the same
        // bounded preview and fingerprint. Full task text remains in the app.
        title:
          record.title.length > 120
            ? record.title.slice(0, 119) + "…"
            : record.title,
        body:
          record.body.length > 240
            ? record.body.slice(0, 239) + "…"
            : record.body,
        id: boundedReminderId(record.id),
        kind: record.kind.length > 50 ? "activity" : record.kind,
      });
  };
  const reference = new Map<
    string,
    {
      entry: RotaEntry;
      shift: boolean;
      transition: boolean;
    }
  >();
  const choose = (
    entry: RotaEntry | undefined,
    kind: "shift" | "transition",
  ) => {
    if (!entry || entry.date > lastDate) return;
    const item = reference.get(entry.id) ?? {
      entry,
      shift: false,
      transition: false,
    };
    item[kind] = true;
    reference.set(entry.id, item);
  };
  const sample = (at: number) => {
    const panels = panelRollover(state.entries, settings, { now: () => at });
    choose(panels.shiftPlanShift, "shift");
    choose(panels.transitionShift, "transition");
  };
  sample(now);
  // Midnight rollover must not cancel the remaining finish/return alerts of
  // an overnight duty that is still in progress from the previous date.
  for (const entry of state.entries) {
    try {
      const bounds = workBounds(entry);
      if (bounds && bounds.start <= now && bounds.end > now)
        choose(entry, "shift");
    } catch {
      /* Unresolved duty times cannot establish exact notifications. */
    }
  }
  for (let day = 0; day <= horizonDays; day++) {
    // Noon represents the calendar date after the 00:01 rollover, and avoids
    // assuming that every timezone has a valid midnight or a 24-hour day.
    try {
      sample(onDate(addDays(firstDate, day), "12:00", settings.timezone));
    } catch {
      /* A skipped local date has no panel activities to deliver. */
    }
  }
  const savedTasks = new Map(state.tasks.map((task) => [task.id, task]));
  // Distant work cannot occupy this bounded notification horizon. Retain
  // preceding dates for recovery calculations and the closest older duty as
  // context, rather than replanning every day of a year-long rota per panel.
  const earliestDate = addDays(firstDate, -3);
  const older = state.entries
    .filter((entry) => entry.date < earliestDate)
    .sort((a, b) => b.date.localeCompare(a.date))
    .find((entry) => entry.status === "Work");
  const planningEntries = state.entries.filter(
    (entry) => entry.date >= earliestDate && entry.date <= planningLastDate,
  );
  if (older) planningEntries.push(older);
  const reviewedFixed = new Set<string>();
  const occurrenceKey = (taskId: string, date?: string) =>
    `${taskId}:${date ?? "once"}`;
  const taskIdentifier = (row: PreparationRow) => {
    const part = row.id.match(/:part:(\d+)$/)?.[1];
    return `${REMINDER_PREFIX}task:${encodeURIComponent(row.taskId!)}${row.occurrenceDate ? `:${row.occurrenceDate}` : ""}${part ? `:part:${part}` : ""}`;
  };
  const dateText = (date: string) => displayDate(date, settings.dateFormat);
  const fixedLead = (task: Task, date: string | undefined, at: number) => {
    if (!(task.travelMinutes > 0)) return;
    add({
      id: `${REMINDER_PREFIX}appointment:${encodeURIComponent(task.id)}${date ? `:${date}` : ""}`,
      at: at - task.travelMinutes * MINUTE,
      title: "Leave for appointment",
      body: `${task.title}. Allow ${task.travelMinutes} minutes for travel.`,
      kind: "appointment",
      ...(task.linkedShiftId ? { entryId: task.linkedShiftId } : {}),
    });
  };
  for (const { entry, shift, transition } of reference.values()) {
    const plan = planShift(entry, settings, planningEntries, state.tasks);
    const shiftDate = entry.start ? entry.start.slice(0, 10) : entry.date,
      preparationDate = addDays(shiftDate, -1);
    const hasPanelTasks = state.tasks.some((task) => {
      if (task.linkedShiftId) return task.linkedShiftId === entry.id;
      // Task bounds are stored in the settings timezone; in a different duty
      // timezone a neighbouring local date may fall inside this panel's day.
      if (entry.timezone !== settings.timezone) return true;
      // Even completed tasks must be projected when they can replace a
      // canonical row, so completion still suppresses a merged bedtime alert.
      // Untimed/deferred suggestions whose bounds include either date need the
      // full scheduler; tasks entirely outside both dates cannot appear here.
      const dates = [task.earliest, task.deadline, task.scheduledStart]
        .filter((value): value is string => !!value)
        .map((value) => value.slice(0, 10));
      return (
        dates.some((date) => date >= preparationDate && date <= shiftDate) ||
        (task.earliest.slice(0, 10) < preparationDate &&
          task.deadline.slice(0, 10) > shiftDate)
      );
    });
    const preparation: PreparationPlan = hasPanelTasks
      ? planPreparation(
          planningEntries,
          state.tasks,
          settings,
          { now: () => now },
          {
            selectedShift: entry,
            shiftPlan: plan,
          },
        )
      : {
          today: firstDate,
          todayStatus: "Unknown",
          nextShift: entry,
          preparationDate,
          shiftPlan: plan,
          preparesFor: "later",
          rows: [],
          placements: [],
          missing: plan.missing,
          conflicts: plan.conflicts,
          provisional: plan.provisional,
        };
    const panels = shiftDayPanels(preparation, state.tasks, settings);
    if (!panels.shiftDate) continue;
    const rows = [
      ...(shift ? panels.shiftRows : []),
      ...(transition ? panels.transitionRows : []),
      // An overnight finish/return is still an activity for that selected duty,
      // even when its instant falls beyond the duty's starting calendar date.
      ...(shift
        ? panels.otherShiftEvents.filter(
            (row) =>
              row.at !== null &&
              localAt(row.at, panels.timezone).slice(0, 10) > panels.shiftDate!,
          )
        : []),
    ];
    for (const row of rows) {
      const task = row.taskId ? savedTasks.get(row.taskId) : undefined;
      const fixed = task?.kind === "fixed";
      if (fixed) reviewedFixed.add(occurrenceKey(task.id, row.occurrenceDate));
      if (
        row.at === null ||
        !Number.isFinite(row.at) ||
        row.conflict ||
        inactive(row.status)
      )
        continue;
      if (
        task &&
        inactive(
          task.occurrenceStates?.[row.occurrenceDate ?? ""] ?? task.state,
        )
      )
        continue;
      const canonical = row.id.startsWith("shift-event:");
      // A concrete displayed time remains eligible when unrelated inputs are
      // missing. An actual sleep conflict still withholds its affected prompts.
      if (
        canonical &&
        sleepKinds.has(row.kind) &&
        preparation.shiftPlan?.conflicts.length
      )
        continue;
      if (row.kind === "caffeine" && !settings.caffeine) continue;
      const kind = canonical ? row.kind : fixed ? "appointment" : "task";
      const wakeAdvice =
        row.kind === "wake"
          ? " Wake-up reminder only: use a separate phone alarm."
          : "";
      add({
        id: canonical
          ? `${REMINDER_PREFIX}duty:${encodeURIComponent(entry.id)}:${row.kind}`
          : taskIdentifier(row),
        at: row.at,
        title: row.kind === "wake" ? "Wake-up reminder" : row.label,
        body: `${dateText(localAt(row.at, panels.timezone).slice(0, 10))}. ${task ? "Your planned task is due." : `${entry.category} duty on ${dateText(panels.shiftDate)}.`}${wakeAdvice}`,
        kind,
        entryId: entry.id,
      });
      if (fixed) fixedLead(task, row.occurrenceDate, row.at);
    }
  }
  // Retain recorded fixed appointments even on days with no selected work panel.
  // Panel-reviewed conflicts/completions are withheld instead of reintroduced.
  if (enabled.has("appointment")) {
    for (const task of state.tasks) {
      if (task.kind !== "fixed" || inactive(task.state)) continue;
      if (
        task.linkedShiftId &&
        !state.entries.some(
          (entry) => entry.id === task.linkedShiftId && entry.status === "Work",
        )
      )
        continue;
      try {
        const chosen = task.scheduledStart ?? task.earliest,
          deadline = zonedEpoch(task.deadline, settings.timezone);
        const dates: (string | undefined)[] = [];
        if (task.recurrence === "none") dates.push(undefined);
        else {
          const lastDate = localAt(
            Math.min(deadline, through + DAY),
            settings.timezone,
          ).slice(0, 10);
          for (
            let date = task.earliest.slice(0, 10);
            date <= lastDate;
            date = addDays(date, task.recurrence === "daily" ? 1 : 7)
          )
            dates.push(date);
        }
        for (const date of dates) {
          if (
            reviewedFixed.has(occurrenceKey(task.id, date)) ||
            inactive(
              date ? (task.occurrenceStates?.[date] ?? "pending") : task.state,
            )
          )
            continue;
          try {
            const at = zonedEpoch(
              date ? `${date}T${chosen.slice(11, 16)}` : chosen,
              settings.timezone,
            );
            if (at > deadline) continue;
            add({
              id: `${REMINDER_PREFIX}task:${encodeURIComponent(task.id)}${date ? `:${date}` : ""}`,
              at,
              title: task.title,
              body: `${dateText(localAt(at, settings.timezone).slice(0, 10))}. Your recorded appointment is due.`,
              kind: "appointment",
              ...(task.linkedShiftId ? { entryId: task.linkedShiftId } : {}),
            });
            fixedLead(task, date, at);
          } catch {
            /* Withhold only an unresolved DST occurrence. */
          }
        }
      } catch {
        /* Invalid recorded appointments remain available for review. */
      }
    }
  }
  if (enabled.has("transition")) {
    for (const change of transitions(state.entries, settings, clock)) {
      try {
        const reviewDate =
          change.adjustmentDates[0] ?? addDays(change.nextDate, -1);
        add({
          id: `${REMINDER_PREFIX}transition:${encodeURIComponent(change.id)}`,
          at: zonedEpoch(`${reviewDate}T12:00`, settings.timezone),
          title: "Review your upcoming shift change",
          body: `${change.to} duties start on ${dateText(change.nextDate)}. Review preparation tasks and the transition plan.`,
          kind: "transition",
        });
      } catch {
        /* No exact reminder for an unresolved local time. */
      }
    }
  }
  return [...result.values()]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(
      0,
      Number.isFinite(options.max)
        ? Math.max(0, Math.min(MAX_WEB_REMINDERS, Math.floor(options.max!)))
        : MAX_REMINDERS,
    );
}

export interface ScheduledReminder {
  id: string;
  fingerprint: string | null;
  at: number | null;
}
export interface ReminderAdapter {
  list(): Promise<ScheduledReminder[]>;
  cancel(id: string): Promise<void>;
  schedule(record: ReminderRecord, fingerprint: string): Promise<void>;
}
export const reminderFingerprint = (record: ReminderRecord) =>
  JSON.stringify([
    record.at,
    record.title,
    record.body,
    record.kind,
    record.entryId ?? null,
  ]);

/** Cancel obsolete/changed requests first, then schedule. Identical plans make no writes. */
export async function reconcileReminders(
  adapter: ReminderAdapter,
  desired: ReminderRecord[],
): Promise<void> {
  const intended = new Map(desired.map((record) => [record.id, record]));
  const retained = new Set<string>();
  for (const existing of await adapter.list()) {
    if (!existing.id.startsWith(REMINDER_PREFIX)) continue;
    const record = intended.get(existing.id);
    if (record && existing.fingerprint === reminderFingerprint(record)) {
      retained.add(existing.id);
    } else {
      await adapter.cancel(existing.id);
    }
  }
  for (const record of intended.values()) {
    if (!retained.has(record.id))
      await adapter.schedule(record, reminderFingerprint(record));
  }
}

export interface NotificationStatus {
  permission: string;
  supported: boolean;
  scheduled: number;
  through: number | null;
  message: string;
}
export function permissionDescription(permission: {
  granted?: boolean;
  status: string;
  ios?: { status: number };
}): { permission: string; allowed: boolean; detail: string } {
  if (permission.ios?.status === 3)
    return {
      permission: "provisional",
      allowed: true,
      detail: "iOS permits quiet notifications only; they may not alert you.",
    };
  if (permission.ios?.status === 4)
    return {
      permission: "ephemeral",
      allowed: true,
      detail: "iOS notification permission is temporary.",
    };
  if (
    permission.ios?.status === 1 ||
    (!permission.ios && permission.status === "denied")
  )
    return {
      permission: "denied",
      allowed: false,
      detail:
        "Notification permission is denied. Enable it in your phone settings if you want reminders.",
    };
  if (
    permission.ios?.status === 2 ||
    (!permission.ios && (permission.granted || permission.status === "granted"))
  )
    return {
      permission: "granted",
      allowed: true,
      detail: "Ordinary local notifications are permitted.",
    };
  return {
    permission: "undetermined",
    allowed: false,
    detail: "Reminders need your permission; use Enable reminders to opt in.",
  };
}
export const ALARM_LIMITATION =
  "Wake-up reminders are ordinary notifications. Use a separate phone alarm. Silent mode, Focus/Do Not Disturb, battery restrictions and OS delivery may prevent an alert.";
