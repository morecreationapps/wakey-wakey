import type { ReminderRecord } from "../model";
import { notificationScope } from "./notificationScope";

/** The same due activity is used by browser and native in-app banners. */
export type DueAlert = ReminderRecord & {
  fingerprint: string;
  interaction?: "received" | "opened";
};

export type DueAlertListener = (alert: DueAlert) => void;

const listeners = new Set<DueAlertListener>();

export function subscribeDueAlerts(listener: DueAlertListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The platform adapter also fences its async operation before calling this. */
export function emitDueAlert(alert: DueAlert, expectedOwner?: string): void {
  const owner = notificationScope().owner;
  if (!owner || (expectedOwner !== undefined && owner !== expectedOwner))
    return;
  for (const listener of listeners) listener(alert);
}
