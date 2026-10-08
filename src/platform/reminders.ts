import { AppState, Clock, ReminderRecord } from "../model";
import { planShift, transitions } from "../engine/planner";
import { addDays, displayDate, localAt, zonedEpoch } from "../engine/time";

export const REMINDER_PREFIX = "wakey:";
export const REMINDER_HORIZON_DAYS = 14;
export const MAX_REMINDERS = 60;
const DAY = 86_400_000;
const sleepKinds = new Set(["windDown", "bedtime", "wake", "caffeine"]);
const supportedKinds = new Set([
  "prepare",
  "windDown",
  "bedtime",
  "wake",
  "departure",
  "appointment",
  "transition",
  "caffeine",
]);

/** Deterministic notification intentions; never reads the device timezone or permissions. */
export function desiredReminders(
  state: AppState,
  clock: Clock,
): ReminderRecord[] {
  const settings = state.settings;
  if (
    !settings.remindersEnabled ||
    !settings.onboardingComplete ||
    !settings.timezoneConfirmed
  )
    return [];
  const now = clock.now();
  const through = now + REMINDER_HORIZON_DAYS * DAY;
  const enabled = new Set(
    settings.reminderKinds.filter((kind) => supportedKinds.has(kind)),
  );
  const result = new Map<string, ReminderRecord>();
  const add = (record: ReminderRecord) => {
    if (
      enabled.has(record.kind) &&
      Number.isFinite(record.at) &&
      record.at > now &&
      record.at <= through
    )
      result.set(record.id, record);
  };
  for (const entry of state.entries) {
    if (entry.status !== "Work" || !entry.start) continue;
    try {
      const start = zonedEpoch(
        entry.start,
        entry.timezone,
        entry.disambiguation,
      );
      if (start <= now || start > through + DAY) continue;
    } catch {
      continue;
    }
    const plan = planShift(entry, settings, state.entries, state.tasks);
    // Missing recovery, ambiguous local times or a sleep conflict cannot become precise sleep prompts.
    const safeSleep = !plan.provisional && plan.conflicts.length === 0;
    for (const event of plan.events) {
      if (!enabled.has(event.kind)) continue;
      if (sleepKinds.has(event.kind) && !safeSleep) continue;
      if (event.kind === "caffeine" && !settings.caffeine) continue;
      const wakeAdvice =
        event.kind === "wake"
          ? " Wake-up reminder only: use a separate phone alarm."
          : "";
      add({
        id: `${REMINDER_PREFIX}duty:${encodeURIComponent(entry.id)}:${event.kind}`,
        at: event.at,
        title: event.kind === "wake" ? "Wake-up reminder" : event.label,
        body: `${entry.category} duty on ${settings.dateFormat === "LONG" ? displayDate(entry.date, "LONG") : entry.date}. ${event.why}${wakeAdvice}`,
        kind: event.kind,
        entryId: entry.id,
      });
    }
  }
  if (enabled.has("appointment")) {
    for (const task of state.tasks) {
      if (
        task.kind !== "fixed" ||
        ["completed", "skipped", "deferred"].includes(task.state)
      )
        continue;
      try {
        const chosen = task.scheduledStart ?? task.earliest;
        const deadline = zonedEpoch(task.deadline, settings.timezone);
        if (task.recurrence === "none") {
          add({
            id: `${REMINDER_PREFIX}appointment:${encodeURIComponent(task.id)}`,
            at:
              zonedEpoch(chosen, settings.timezone) -
              task.travelMinutes * 60_000,
            title: "Appointment reminder",
            body: `${task.title}. ${task.travelMinutes ? `Allow ${task.travelMinutes} minutes for travel.` : "Your recorded appointment time."}`,
            kind: "appointment",
          });
        } else {
          // Expand only recorded recurrence, preserving the entered wall-clock appointment time across DST.
          const lastDate = localAt(
            Math.min(deadline, through + DAY),
            settings.timezone,
          ).slice(0, 10);
          for (
            let date = task.earliest.slice(0, 10);
            date <= lastDate;
            date = addDays(date, task.recurrence === "daily" ? 1 : 7)
          ) {
            if (
              ["completed", "skipped", "deferred"].includes(
                task.occurrenceStates?.[date] ?? "pending",
              )
            )
              continue;
            try {
              const at = zonedEpoch(
                `${date}T${chosen.slice(11, 16)}`,
                settings.timezone,
              );
              if (at > deadline) continue;
              add({
                id: `${REMINDER_PREFIX}appointment:${encodeURIComponent(task.id)}:${date}`,
                at: at - task.travelMinutes * 60_000,
                title: "Appointment reminder",
                body: `${task.title}. Recorded ${task.recurrence} appointment; allow ${task.travelMinutes} minutes for travel.`,
                kind: "appointment",
              });
            } catch {
              /* Withhold only the unresolved DST occurrence, not later valid appointments. */
            }
          }
        }
      } catch {
        /* Invalid or ambiguous user-entered appointment time stays visible for review in the planner. */
      }
    }
  }
  if (enabled.has("transition")) {
    for (const change of transitions(state.entries, settings, clock)) {
      try {
        // A noon planning review, never a bedtime or body-clock prescription.
        const reviewDate =
          change.adjustmentDates[0] ?? addDays(change.nextDate, -1);
        add({
          id: `${REMINDER_PREFIX}transition:${encodeURIComponent(change.id)}`,
          at: zonedEpoch(`${reviewDate}T12:00`, settings.timezone),
          title: "Review your upcoming shift change",
          body: `${change.to} duties start on ${settings.dateFormat === "LONG" ? displayDate(change.nextDate, "LONG") : change.nextDate}. ${change.provisional ? "Some information is still needed; review the provisional plan." : "Review preparation tasks and the transition plan."}`,
          kind: "transition",
        });
      } catch {
        /* No exact reminder for an unresolved local time. */
      }
    }
  }
  return [...result.values()]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, MAX_REMINDERS);
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
  "Wake-up reminders are ordinary notifications. Use a separate phone alarm. Silent mode, Focus/Do Not Disturb, battery restrictions and OS delivery may prevent an alert. Reopen the app to refresh the next 14 days; at most 60 reminders are queued.";
