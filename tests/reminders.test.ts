import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialState,
  newSettings,
  suppliedProfile,
} from "../src/data/defaults";
import { AppState, ReminderRecord, RotaEntry, Task } from "../src/model";
import { nextWork } from "../src/engine/planner";
import { addDays, zonedEpoch } from "../src/engine/time";
import {
  desiredReminders,
  MAX_REMINDERS,
  permissionDescription,
  reconcileReminders,
  reminderFingerprint,
  ReminderAdapter,
  ScheduledReminder,
} from "../src/platform/reminders";
import {
  notificationStatus as browserNotificationStatus,
  requestReminders as browserRequest,
} from "../src/platform/notifications.web";
import {
  createSnapshotStore,
  SnapshotDatabase,
  SnapshotQueries,
} from "../src/platform/storeCore";
import * as browserStore from "../src/platform/store.web";
import {
  activateNotificationOwner,
  clearNotificationOwner,
} from "../src/platform/notificationScope";

const NOTIFICATION_OWNER = "11111111-1111-4111-8111-111111111111";
const NEXT_NOTIFICATION_OWNER = "22222222-2222-4222-8222-222222222222";

const nativeMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(async () => ({
    status: "denied",
    granted: false,
    ios: { status: 1 },
  })),
  requestPermissionsAsync: vi.fn(async () => ({
    status: "denied",
    granted: false,
    ios: { status: 1 },
  })),
  getAllScheduledNotificationsAsync: vi.fn(
    async (): Promise<
      { identifier: string; content: { data: Record<string, unknown> } }[]
    > => [],
  ),
  cancelScheduledNotificationAsync: vi.fn(async (_id: string) => undefined),
  scheduleNotificationAsync: vi.fn(
    async (_request: {
      identifier?: string;
      content: Record<string, unknown>;
    }) => "wakey:test",
  ),
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  SchedulableTriggerInputTypes: { DATE: "date", TIME_INTERVAL: "timeInterval" },
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock("expo-notifications", () => nativeMocks);
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const clock = { now: () => zonedEpoch("2032-08-09T12:00", "Europe/London") };
function duty(
  id: string,
  date: string,
  category: RotaEntry["category"] = "Early",
): RotaEntry {
  return {
    id,
    date,
    duty: "001",
    category,
    status: "Work",
    start: `${date}T${category === "Late" ? "14:08" : "06:00"}`,
    end: `${date}T${category === "Late" ? "22:26" : "14:18"}`,
    timezone: "Europe/London",
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
  };
}
function state(): AppState {
  const settings = suppliedProfile(newSettings());
  return {
    ...initialState(),
    settings: {
      ...settings,
      origins: {
        ...settings.origins,
        timezone: "entered",
        arrivalBuffer: "entered",
        sleepTarget: "entered",
        latency: "entered",
        windDown: "entered",
      },
      timezoneConfirmed: true,
      onboardingComplete: true,
      additionalPrepConfirmed: true,
      returnMinutes: 20,
      postWorkMinutes: 45,
      earlyBed: "21:30",
      earlyWake: "05:00",
      lateBed: "23:30",
      lateWake: "08:00",
      restBed: "23:00",
      restWake: "08:00",
      remindersEnabled: true,
    },
    entries: [duty("first", "2032-08-10"), duty("second", "2032-08-11")],
  };
}
function fakeReminders(existing: ScheduledReminder[] = []) {
  const rows = new Map(existing.map((record) => [record.id, record]));
  const calls: string[] = [];
  const adapter: ReminderAdapter = {
    async list() {
      return [...rows.values()];
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      rows.delete(id);
    },
    async schedule(record, fingerprint) {
      calls.push(`schedule:${record.id}`);
      rows.set(record.id, { id: record.id, fingerprint, at: record.at });
    },
  };
  return { adapter, rows, calls };
}

describe("rolling local reminder intentions and reconciliation", () => {
  it("G: confirmed leave removes that duty reminders and makes the following actual workday next", async () => {
    const original = state();
    const fake = fakeReminders();
    await reconcileReminders(fake.adapter, desiredReminders(original, clock));
    expect([...fake.rows.keys()].some((id) => id.includes("duty:first:"))).toBe(
      true,
    );
    const changed: AppState = {
      ...original,
      entries: original.entries.map((entry) =>
        entry.id === "first"
          ? {
              ...entry,
              status: "Holiday",
              leaveApproval: "confirmed",
              start: null,
              end: null,
            }
          : entry,
      ),
    };
    await reconcileReminders(fake.adapter, desiredReminders(changed, clock));
    expect([...fake.rows.keys()].some((id) => id.includes("duty:first:"))).toBe(
      false,
    );
    expect(
      nextWork(changed.entries, clock, changed.settings.timezone)?.id,
    ).toBe("second");
    expect(
      fake.calls.some((call) => call.startsWith("cancel:wakey:duty:first:")),
    ).toBe(true);
  });
  it("O: repeated calculations and repeated reconciliation retain stable identifiers without duplicates", async () => {
    const original = state();
    const records = desiredReminders(original, clock);
    expect(records.length).toBeGreaterThan(0);
    expect(records).toEqual(desiredReminders(original, clock));
    const fake = fakeReminders();
    await reconcileReminders(fake.adapter, records);
    fake.calls.length = 0;
    await reconcileReminders(fake.adapter, records);
    expect(fake.calls).toEqual([]);
    expect(fake.rows.size).toBe(records.length);
    expect(new Set(records.map((record) => record.id)).size).toBe(
      records.length,
    );
  });
  it("updates changed commute times by cancelling the old request before replacing it", async () => {
    const original = state();
    const fake = fakeReminders();
    await reconcileReminders(fake.adapter, desiredReminders(original, clock));
    const departureId = "wakey:duty:first:departure";
    const before = fake.rows.get(departureId)!.at!;
    fake.calls.length = 0;
    await reconcileReminders(
      fake.adapter,
      desiredReminders(
        { ...original, settings: { ...original.settings, outboundMax: 25 } },
        clock,
      ),
    );
    expect(fake.rows.get(departureId)!.at).toBe(before - 5 * 60_000);
    expect(fake.calls.indexOf(`cancel:${departureId}`)).toBeLessThan(
      fake.calls.indexOf(`schedule:${departureId}`),
    );
  });
  it("withholds precise sleep prompts when recovery is unknown, while retaining calculated departure", () => {
    const original = state();
    const records = desiredReminders(
      {
        ...original,
        settings: {
          ...original.settings,
          returnMinutes: null,
          postWorkMinutes: null,
        },
      },
      clock,
    );
    expect(records.some((record) => record.kind === "departure")).toBe(true);
    expect(
      records.some((record) =>
        ["wake", "bedtime", "windDown"].includes(record.kind),
      ),
    ).toBe(false);
  });
  it("withholds unsafe sleep prompts for an infeasible late-to-early turnaround", () => {
    const original = state();
    original.entries.unshift(duty("prior-late", "2032-08-09", "Late"));
    const first = desiredReminders(original, clock).filter(
      (record) => record.entryId === "first",
    );
    expect(first.some((record) => record.kind === "departure")).toBe(true);
    expect(
      first.some((record) =>
        ["wake", "bedtime", "windDown"].includes(record.kind),
      ),
    ).toBe(false);
  });
  it("honours opt-in, onboarding, timezone confirmation and selected reminder kinds", () => {
    const original = state();
    for (const change of [
      { remindersEnabled: false },
      { onboardingComplete: false },
      { timezoneConfirmed: false },
    ]) {
      expect(
        desiredReminders(
          { ...original, settings: { ...original.settings, ...change } },
          clock,
        ),
      ).toEqual([]);
    }
    const records = desiredReminders(
      {
        ...original,
        settings: { ...original.settings, reminderKinds: ["departure"] },
      },
      clock,
    );
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.kind === "departure")).toBe(true);
  });
  it("caps a busy 52-week rota at 60 future reminders in the next 14 days", () => {
    const original = state();
    original.entries = Array.from({ length: 364 }, (_, i) =>
      duty(`rota-${i}`, addDays("2032-08-10", i)),
    );
    const records = desiredReminders(original, clock);
    expect(records).toHaveLength(MAX_REMINDERS);
    expect(
      records.every(
        (record) =>
          record.at > clock.now() && record.at <= clock.now() + 14 * 86_400_000,
      ),
    ).toBe(true);
    expect(
      records.every((record, i) => i === 0 || record.at >= records[i - 1].at),
    ).toBe(true);
  });
  it("deduplicates repeated duty intentions and never touches requests owned elsewhere", async () => {
    const original = state();
    original.entries.push({ ...original.entries[0] });
    const records = desiredReminders(original, clock);
    expect(
      records.filter((record) => record.id === "wakey:duty:first:departure"),
    ).toHaveLength(1);
    const fake = fakeReminders([
      { id: "another-feature:1", fingerprint: null, at: null },
    ]);
    await reconcileReminders(fake.adapter, []);
    expect(fake.rows.has("another-feature:1")).toBe(true);
    expect(fake.calls).toEqual([]);
  });
  it("disabling cancels future app reminders and a failed cancellation propagates instead of adding duplicates", async () => {
    const fake = fakeReminders();
    await reconcileReminders(fake.adapter, desiredReminders(state(), clock));
    await reconcileReminders(fake.adapter, []);
    expect(fake.rows.size).toBe(0);
    const record: ReminderRecord = {
      id: "wakey:test-change",
      at: clock.now() + 60_000,
      title: "Changed",
      body: "",
      kind: "prepare",
    };
    const schedule = vi.fn(async () => undefined);
    await expect(
      reconcileReminders(
        {
          list: async () => [
            { id: record.id, fingerprint: "old", at: record.at },
          ],
          cancel: async () => {
            throw new Error("OS cancellation failed");
          },
          schedule,
        },
        [record],
      ),
    ).rejects.toThrow("OS cancellation failed");
    expect(schedule).not.toHaveBeenCalled();
  });
  it("keeps a fixed appointment at its entered time and includes its entered travel allowance", () => {
    const original = state();
    const task: Task = {
      id: "haircut",
      title: "Booked haircut",
      kind: "fixed",
      minutes: 30,
      earliest: "2032-08-10T15:00",
      deadline: "2032-08-10T16:00",
      windowStart: "09:00",
      windowEnd: "17:00",
      priority: 1,
      recurrence: "none",
      location: "",
      travelMinutes: 15,
      movable: false,
      splittable: false,
      locked: true,
      scheduledStart: "2032-08-10T15:00",
      state: "accepted",
    };
    original.tasks.push(task);
    const appointment = desiredReminders(original, clock).find(
      (record) => record.kind === "appointment",
    );
    expect(appointment?.at).toBe(
      zonedEpoch("2032-08-10T14:45", "Europe/London"),
    );
    expect(original.tasks[0].scheduledStart).toBe("2032-08-10T15:00");
  });
  it("distinguishes ordinary waking reminders and fingerprints an altered event", () => {
    const record = desiredReminders(state(), clock).find(
      (item) => item.kind === "wake",
    )!;
    expect(record.title).toBe("Wake-up reminder");
    expect(record.body).toContain("separate phone alarm");
    expect(reminderFingerprint(record)).not.toBe(
      reminderFingerprint({ ...record, at: record.at + 60_000 }),
    );
  });
  it("preserves recurring fixed appointment wall-clock times through DST and withholds the ambiguous occurrence", () => {
    const original = state();
    original.entries = [];
    original.tasks = [
      {
        id: "daily",
        title: "Fixed daily check",
        kind: "fixed",
        minutes: 15,
        earliest: "2026-10-24T01:30",
        deadline: "2026-10-27T03:00",
        windowStart: "01:00",
        windowEnd: "03:00",
        priority: 1,
        recurrence: "daily",
        location: "",
        travelMinutes: 0,
        movable: false,
        splittable: false,
        locked: true,
        scheduledStart: "2026-10-24T01:30",
        state: "accepted",
      },
    ];
    const records = desiredReminders(original, {
      now: () => zonedEpoch("2026-10-23T12:00", "Europe/London"),
    });
    expect(records.some((record) => record.id.endsWith("2026-10-25"))).toBe(
      false,
    );
    expect(records.find((record) => record.id.endsWith("2026-10-24"))?.at).toBe(
      zonedEpoch("2026-10-24T01:30", "Europe/London"),
    );
    expect(records.find((record) => record.id.endsWith("2026-10-26"))?.at).toBe(
      zonedEpoch("2026-10-26T01:30", "Europe/London"),
    );
  });
});

describe("recurring appointment completion", () => {
  it("removes reminders only for completed, skipped or deferred occurrences", async () => {
    const original = state();
    original.entries = [];
    original.tasks = [
      {
        id: "daily",
        title: "Recorded appointment",
        kind: "fixed",
        minutes: 15,
        earliest: "2032-08-10T15:00",
        deadline: "2032-08-13T16:00",
        windowStart: "14:00",
        windowEnd: "17:00",
        priority: 1,
        recurrence: "daily",
        location: "",
        travelMinutes: 0,
        movable: false,
        splittable: false,
        locked: true,
        scheduledStart: "2032-08-10T15:00",
        state: "accepted",
      },
    ];
    const fake = fakeReminders();
    await reconcileReminders(fake.adapter, desiredReminders(original, clock));
    expect(fake.rows.size).toBe(4);
    original.tasks[0] = {
      ...original.tasks[0],
      occurrenceStates: {
        "2032-08-10": "completed",
        "2032-08-11": "skipped",
        "2032-08-12": "deferred",
      },
    };
    await reconcileReminders(fake.adapter, desiredReminders(original, clock));
    expect([...fake.rows.keys()]).toEqual([
      "wakey:appointment:daily:2032-08-13",
    ]);
    expect(original.tasks[0].state).toBe("accepted");
  });
});

describe("N: visible permission and unsupported alarm status", () => {
  it("denial is visible and is never treated as permission", () => {
    const result = permissionDescription({ status: "denied", granted: false });
    expect(result.allowed).toBe(false);
    expect(result.permission).toBe("denied");
    expect(result.detail).toContain("phone settings");
  });
  it("iOS provisional permission permits quiet reminders but says they may not alert", () => {
    const result = permissionDescription({
      status: "denied",
      granted: false,
      ios: { status: 3 },
    });
    expect(result.allowed).toBe(true);
    expect(result.permission).toBe("provisional");
    expect(result.detail).toContain("quiet notifications");
  });
  it("uses the granular iOS status ahead of the root status", () => {
    expect(
      permissionDescription({ status: "denied", ios: { status: 2 } }).allowed,
    ).toBe(true);
    expect(
      permissionDescription({ status: "granted", ios: { status: 1 } }).allowed,
    ).toBe(false);
    expect(
      permissionDescription({ status: "granted", ios: { status: 0 } }).allowed,
    ).toBe(false);
  });
  it("browser support is explicitly unavailable and never claims an active alarm", async () => {
    for (const result of [
      await browserNotificationStatus(),
      await browserRequest(),
    ]) {
      expect(result.supported).toBe(false);
      expect(result.scheduled).toBe(0);
      expect(result.permission).toBe("unsupported");
      expect(result.message).toContain("No alarm is active");
    }
  });
  it("native permission denial returns visible status, cancels obsolete app reminders and never schedules", async () => {
    const native = await import("../src/platform/notifications");
    activateNotificationOwner(NOTIFICATION_OWNER);
    nativeMocks.getAllScheduledNotificationsAsync.mockResolvedValueOnce([
      { identifier: "wakey:duty:deleted:departure", content: { data: {} } },
    ]);
    const result = await native.syncReminders(state(), clock);
    expect(result.permission).toBe("denied");
    expect(result.scheduled).toBe(0);
    expect(result.message).toContain("separate phone alarm");
    expect(nativeMocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      "wakey:duty:deleted:departure",
    );
    expect(nativeMocks.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(nativeMocks.requestPermissionsAsync).not.toHaveBeenCalled();
  });
  it("native test and explicit permission requests handle denial without an alarm or crash", async () => {
    const native = await import("../src/platform/notifications");
    activateNotificationOwner(NOTIFICATION_OWNER);
    expect((await native.testNotification()).permission).toBe("denied");
    expect((await native.requestReminders()).permission).toBe("denied");
    expect(nativeMocks.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(nativeMocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
  it("serialises concurrent native resyncs so the latest rota wins and StrictEffects repeats add nothing", async () => {
    const native = await import("../src/platform/notifications");
    activateNotificationOwner(NOTIFICATION_OWNER);
    const rows = new Map<
      string,
      { identifier: string; content: { data: Record<string, unknown> } }
    >();
    nativeMocks.getPermissionsAsync.mockResolvedValue({
      status: "granted",
      granted: true,
      ios: { status: 2 },
    });
    nativeMocks.getAllScheduledNotificationsAsync.mockImplementation(
      async () => [...rows.values()],
    );
    nativeMocks.cancelScheduledNotificationAsync.mockImplementation(
      async (id) => {
        rows.delete(id);
      },
    );
    nativeMocks.scheduleNotificationAsync.mockImplementation(
      async (request) => {
        const identifier = request.identifier!;
        rows.set(identifier, {
          identifier,
          content: { data: request.content.data as Record<string, unknown> },
        });
        return identifier;
      },
    );
    const original = state();
    const middle = {
      ...original,
      settings: { ...original.settings, outboundMax: 25 },
    };
    const latest = {
      ...original,
      settings: { ...original.settings, outboundMax: 30 },
    };
    await Promise.all([
      native.syncReminders(original, clock),
      native.syncReminders(middle, clock),
      native.syncReminders(latest, clock),
    ]);
    const expected = desiredReminders(latest, clock);
    expect(rows.size).toBe(expected.length);
    for (const record of expected)
      expect(rows.get(record.id)?.content.data.wakeyFingerprint).toBe(
        reminderFingerprint(record),
      );
    const writes = nativeMocks.scheduleNotificationAsync.mock.calls.length;
    const cancellations =
      nativeMocks.cancelScheduledNotificationAsync.mock.calls.length;
    await Promise.all([
      native.syncReminders(latest, clock),
      native.syncReminders(latest, clock),
    ]);
    expect(nativeMocks.scheduleNotificationAsync.mock.calls.length).toBe(
      writes,
    );
    expect(nativeMocks.cancelScheduledNotificationAsync.mock.calls.length).toBe(
      cancellations,
    );
    const result = await native.notificationStatus();
    expect(result.scheduled).toBe(expected.length);
    expect(result.through).toBe(
      Math.max(...expected.map((record) => record.at)),
    );
  });
  it("invalidates queued resyncs at logout and refuses a previous owner's callback after account switching", async () => {
    const native = await import("../src/platform/notifications");
    const rows = new Map<
      string,
      { identifier: string; content: { data: Record<string, unknown> } }
    >();
    const permission = {
      status: "granted",
      granted: true,
      ios: { status: 2 },
    };
    nativeMocks.getPermissionsAsync.mockResolvedValue(permission);
    nativeMocks.getAllScheduledNotificationsAsync.mockImplementation(
      async () => [...rows.values()],
    );
    nativeMocks.cancelScheduledNotificationAsync.mockImplementation(
      async (id) => {
        rows.delete(id);
      },
    );
    nativeMocks.scheduleNotificationAsync.mockImplementation(
      async (request) => {
        const identifier = request.identifier!;
        rows.set(identifier, {
          identifier,
          content: { data: request.content.data as Record<string, unknown> },
        });
        return identifier;
      },
    );
    activateNotificationOwner(NOTIFICATION_OWNER);
    const original = state();
    await native.syncReminders(original, clock, NOTIFICATION_OWNER);
    expect(rows.size).toBeGreaterThan(0);
    const priorWrites = nativeMocks.scheduleNotificationAsync.mock.calls.length;

    // Hold the native queue in an OS permission read, then invalidate the
    // captured account before the queued resync can begin reconciliation.
    let entered!: () => void;
    let release!: () => void;
    const permissionReadStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permissionRead = new Promise<typeof permission>((resolve) => {
      release = () => resolve(permission);
    });
    nativeMocks.getPermissionsAsync.mockImplementationOnce(async () => {
      entered();
      return permissionRead;
    });
    const blockingStatus = native.notificationStatus();
    await permissionReadStarted;
    const changed = {
      ...original,
      settings: { ...original.settings, outboundMax: 37 },
    };
    const queuedResync = native.syncReminders(
      changed,
      clock,
      NOTIFICATION_OWNER,
    );
    clearNotificationOwner(NOTIFICATION_OWNER);
    const cancellation = native.disableReminders();
    release();
    await Promise.all([blockingStatus, queuedResync, cancellation]);
    expect(rows.size).toBe(0);
    expect(nativeMocks.scheduleNotificationAsync.mock.calls.length).toBe(
      priorWrites,
    );

    activateNotificationOwner(NEXT_NOTIFICATION_OWNER);
    await native.syncReminders(changed, clock, NOTIFICATION_OWNER);
    expect(rows.size).toBe(0);
    expect(nativeMocks.scheduleNotificationAsync.mock.calls.length).toBe(
      priorWrites,
    );

    // The active next account can still schedule its own reminders.
    await native.syncReminders(original, clock, NEXT_NOTIFICATION_OWNER);
    expect(rows.size).toBe(desiredReminders(original, clock).length);
    expect(
      nativeMocks.scheduleNotificationAsync.mock.calls.length,
    ).toBeGreaterThan(priorWrites);
  });
  it("does not schedule a previous account's test reminder when logout happens during an OS permission wait", async () => {
    const native = await import("../src/platform/notifications");
    const permission = { status: "granted", granted: true, ios: { status: 2 } };
    nativeMocks.getPermissionsAsync.mockResolvedValue(permission);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permissionRead = new Promise<typeof permission>((resolve) => {
      release = () => resolve(permission);
    });
    nativeMocks.getPermissionsAsync.mockImplementationOnce(async () => {
      entered();
      return permissionRead;
    });
    activateNotificationOwner(NOTIFICATION_OWNER);
    const oldRequest = native.testNotification();
    await started;
    clearNotificationOwner(NOTIFICATION_OWNER);
    activateNotificationOwner(NEXT_NOTIFICATION_OWNER);
    release();
    await oldRequest;
    expect(nativeMocks.scheduleNotificationAsync).not.toHaveBeenCalled();

    const activeRequest = await native.testNotification();
    expect(
      nativeMocks.scheduleNotificationAsync,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ identifier: "wakey:test" }),
    );
    expect(activeRequest.message).toContain("Test requested");
  });
  it("cancels a test reminder whose OS scheduling finishes after its account logs out", async () => {
    const native = await import("../src/platform/notifications");
    nativeMocks.getPermissionsAsync.mockResolvedValue({
      status: "granted",
      granted: true,
      ios: { status: 2 },
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scheduled = new Promise<string>((resolve) => {
      release = () => resolve("wakey:test");
    });
    nativeMocks.scheduleNotificationAsync.mockImplementationOnce(async () => {
      entered();
      return scheduled;
    });
    activateNotificationOwner(NOTIFICATION_OWNER);
    const oldRequest = native.testNotification();
    await started;
    clearNotificationOwner(NOTIFICATION_OWNER);
    release();
    const result = await oldRequest;
    expect(nativeMocks.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(
      2,
    );
    expect(
      nativeMocks.cancelScheduledNotificationAsync,
    ).toHaveBeenLastCalledWith("wakey:test");
    expect(result.message).not.toContain("Test requested");
  });
});

function fakeDatabase() {
  let row: { schema_version: number; payload: string } | null = null;
  let version = 0;
  let failNextWrite = false;
  let transactionActive = false;
  const statements: { sql: string; params: (string | number | null)[] }[] = [];
  const db: SnapshotDatabase = {
    async execAsync(sql) {
      statements.push({ sql, params: [] });
      if (sql.includes("user_version = 1")) version = 1;
    },
    async getFirstAsync<T>(sql: string) {
      return (
        sql.includes("PRAGMA user_version") ? { user_version: version } : row
      ) as T | null;
    },
    async runAsync(sql, ...params) {
      if (!transactionActive) throw new Error("Write escaped the transaction");
      statements.push({ sql, params });
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("Disk full");
      }
      if (sql.startsWith("INSERT"))
        row = {
          schema_version: params[1] as number,
          payload: params[2] as string,
        };
      if (sql.startsWith("DELETE")) row = null;
    },
    async withExclusiveTransactionAsync(
      task: (transaction: SnapshotQueries) => Promise<void>,
    ) {
      const before = row;
      transactionActive = true;
      try {
        await task(db);
      } catch (error) {
        row = before;
        throw error;
      } finally {
        transactionActive = false;
      }
    },
  };
  return {
    db,
    statements,
    failWrite: () => {
      failNextWrite = true;
    },
    corrupt: () => {
      row = { schema_version: 1, payload: "{broken" };
    },
    futureVersion: () => {
      version = 2;
    },
  };
}

describe("offline snapshot persistence via the real serial store and a database adapter", () => {
  it("M: no initial record; saves survive a new store instance, including leading-zero duty text", async () => {
    const fake = fakeDatabase();
    const original = state();
    const first = createSnapshotStore(async () => fake.db);
    expect(await first.loadState()).toBeNull();
    await first.saveState(original);
    const afterRestart = createSnapshotStore(async () => fake.db);
    expect(await afterRestart.loadState()).toEqual(original);
    expect((await afterRestart.loadState())?.entries[0].duty).toBe("001");
  });
  it("saves concurrent revisions in call order, binds user text and deletes only after earlier saves", async () => {
    const fake = fakeDatabase();
    const store = createSnapshotStore(async () => fake.db);
    const original = state();
    original.settings.name = "'); DROP TABLE app_snapshot; --";
    const changed = {
      ...original,
      settings: { ...original.settings, name: "Latest revision" },
    };
    await Promise.all([store.saveState(original), store.saveState(changed)]);
    expect((await store.loadState())?.settings.name).toBe("Latest revision");
    const inserts = fake.statements.filter((statement) =>
      statement.sql.startsWith("INSERT"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).not.toContain(original.settings.name);
    expect(inserts[0].params[2]).toContain(original.settings.name);
    const save = store.saveState(original);
    const remove = store.deleteState();
    await Promise.all([save, remove]);
    expect(await store.loadState()).toBeNull();
  });
  it("retains the last committed snapshot after a failed write and permits a later retry", async () => {
    const fake = fakeDatabase();
    const store = createSnapshotStore(async () => fake.db);
    const original = state();
    await store.saveState(original);
    fake.failWrite();
    const changed = { ...original, entries: [] };
    await expect(store.saveState(changed)).rejects.toThrow("Disk full");
    expect(await store.loadState()).toEqual(original);
    await store.saveState(changed);
    expect((await store.loadState())?.entries).toEqual([]);
  });
  it("reports corruption and newer database versions without replacing saved data", async () => {
    const corrupt = fakeDatabase();
    corrupt.corrupt();
    await expect(
      createSnapshotStore(async () => corrupt.db).loadState(),
    ).rejects.toThrow();
    expect(
      corrupt.statements.some(
        (statement) =>
          statement.sql.startsWith("DELETE") ||
          statement.sql.startsWith("INSERT"),
      ),
    ).toBe(false);
    const future = fakeDatabase();
    future.futureVersion();
    await expect(
      createSnapshotStore(async () => future.db).loadState(),
    ).rejects.toThrow("newer version");
    expect(future.statements).toEqual([]);
  });
  it("web storage retains the same snapshot and surfaces quota errors", async () => {
    const values = new Map<string, string>();
    const local = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    vi.stubGlobal("localStorage", local);
    expect(await browserStore.loadState()).toBeNull();
    await browserStore.saveState(state());
    expect(await browserStore.loadState()).toEqual(state());
    local.setItem = () => {
      throw new Error("Quota exceeded");
    };
    await expect(browserStore.saveState(state())).rejects.toThrow(
      "Quota exceeded",
    );
    await browserStore.deleteState();
    expect(await browserStore.loadState()).toBeNull();
  });
});
afterEach(() => {
  clearNotificationOwner();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
