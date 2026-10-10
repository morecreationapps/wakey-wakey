import type { ReminderRecord } from "../model";
import { reminderFingerprint } from "./reminders";

export const DUE_ALERT_GRACE_MS = 90_000;
const MAX_TIMER_MS = 60_000;
const LEDGER_RETENTION_MS = 15 * 86_400_000;
export type DueAlert = ReminderRecord & { fingerprint: string };
export type DeliveryLedger = Record<string, number>;
export interface WebReminderRuntime {
  now(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  isCurrent(owner: string): boolean;
  readLedger(owner: string): DeliveryLedger;
  writeLedger(owner: string, ledger: DeliveryLedger): void;
  emit(alert: DueAlert): void;
}

/** A browser timer is an in-app convenience; server push handles closed apps. */
export function createWebReminderController(runtime: WebReminderRuntime) {
  let owner: string | null = null;
  let intended: ReminderRecord[] = [];
  let timer: unknown = null;
  let version = 0;
  const cancelTimer = () => {
    if (timer !== null) runtime.clearTimer(timer);
    timer = null;
  };
  const deliver = (record: ReminderRecord): boolean => {
    if (!owner || !runtime.isCurrent(owner)) return false;
    const now = runtime.now();
    if (
      !Number.isFinite(record.at) ||
      record.at > now ||
      now - record.at > DUE_ALERT_GRACE_MS
    )
      return false;
    const fingerprint = reminderFingerprint(record);
    const key = `${record.id}:${fingerprint}`;
    const ledger = runtime.readLedger(owner);
    if (Object.hasOwn(ledger, key)) return false;
    const pruned = Object.fromEntries(
      Object.entries(ledger).filter(
        ([, delivered]) =>
          Number.isFinite(delivered) && now - delivered <= LEDGER_RETENTION_MS,
      ),
    );
    pruned[key] = now;
    runtime.writeLedger(owner, pruned);
    if (!runtime.isCurrent(owner)) return false;
    runtime.emit({ ...record, fingerprint });
    return true;
  };
  const tick = () => {
    timer = null;
    if (!owner || !runtime.isCurrent(owner)) {
      intended = [];
      return;
    }
    const now = runtime.now();
    for (const record of intended) {
      if (record.at <= now) deliver(record);
    }
    intended = intended.filter((record) => record.at > now);
    if (!intended.length) return;
    const captured = version;
    timer = runtime.setTimer(
      () => {
        if (captured === version) tick();
      },
      Math.max(1, Math.min(MAX_TIMER_MS, intended[0].at - now)),
    );
  };
  return {
    replace(
      nextOwner: string,
      records: ReminderRecord[],
      options?: { retainDue?: boolean },
    ) {
      cancelTimer();
      ++version;
      // Minute refreshes omit past intentions. Keep a just-due item when the
      // saved plan is unchanged, so refresh cannot race its timer callback.
      const now = runtime.now();
      const justDue =
        options?.retainDue && owner === nextOwner
          ? intended.filter(
              (record) =>
                record.at <= now && now - record.at <= DUE_ALERT_GRACE_MS,
            )
          : [];
      owner = nextOwner;
      intended = [
        ...new Map(
          [...justDue, ...records].map((record) => [record.id, record]),
        ).values(),
      ]
        .filter((record) => Number.isFinite(record.at))
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      tick();
    },
    receive(nextOwner: string, record: ReminderRecord) {
      return nextOwner === owner && deliver(record);
    },
    refresh() {
      cancelTimer();
      ++version;
      tick();
    },
    clear() {
      cancelTimer();
      ++version;
      owner = null;
      intended = [];
    },
    pending() {
      if (!owner || !runtime.isCurrent(owner)) return [];
      const now = runtime.now();
      return intended.filter((record) => record.at > now);
    },
  };
}

/** Resolve both GitHub project deployments and ordinary/local app roots. */
export function webAppRoot(documentUrl: string, manifestUrl?: string): URL {
  const document = new URL(documentUrl);
  if (manifestUrl) {
    const manifest = new URL(manifestUrl, document);
    if (manifest.origin === document.origin) return new URL("./", manifest);
  }
  return new URL("./", document);
}

export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(key))
    throw new Error("Invalid push public key.");
  const decoded = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(decoded, (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length !== 65 || bytes[0] !== 4)
    throw new Error("Invalid push public key.");
  return bytes;
}
