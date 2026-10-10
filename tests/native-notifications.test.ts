import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialState,
  newSettings,
  suppliedProfile,
} from "../src/data/defaults";
import type { AppState, ReminderRecord, RotaEntry } from "../src/model";
import type { DueAlert } from "../src/platform/reminderEvents";
import { zonedEpoch } from "../src/engine/time";
import {
  desiredReminders,
  reminderFingerprint,
} from "../src/platform/reminders";

type NativeNotification = {
  request: {
    identifier: string;
    content: { title: string; body: string; data: Record<string, unknown> };
  };
};
const mocks = vi.hoisted(() => ({
  platform: { OS: "ios" },
  rows: new Map<
    string,
    { identifier: string; content: Record<string, unknown> }
  >(),
  received: null as ((item: NativeNotification) => void) | null,
  responded: null as
    ((item: { notification: NativeNotification }) => void) | null,
  last: null as { notification: NativeNotification } | null,
  removeReceived: vi.fn(),
  removeResponse: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getAllScheduledNotificationsAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  cancelScheduledNotificationAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  addNotificationReceivedListener: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  SchedulableTriggerInputTypes: { DATE: "date", TIME_INTERVAL: "timeInterval" },
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock("expo-notifications", () => mocks);
vi.mock("react-native", () => ({ Platform: mocks.platform }));

const OWNER = "11111111-1111-4111-8111-111111111111";
const NEXT_OWNER = "22222222-2222-4222-8222-222222222222";
const clock = { now: () => zonedEpoch("2032-08-09T12:00", "Europe/London") };
function planner(): AppState {
  const date = "2032-08-10";
  const duty: RotaEntry = {
    id: "early",
    date,
    duty: "001",
    category: "Early",
    status: "Work",
    start: `${date}T06:00`,
    end: `${date}T14:18`,
    timezone: "Europe/London",
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
  };
  return {
    ...initialState(),
    settings: {
      ...suppliedProfile(newSettings()),
      onboardingComplete: true,
      timezoneConfirmed: true,
      remindersEnabled: true,
      reminderKinds: [
        "prepare",
        "windDown",
        "bedtime",
        "wake",
        "departure",
        "activity",
        "task",
        "caffeine",
      ],
    },
    entries: [duty],
  };
}
function notification(
  record: ReminderRecord,
  owner = OWNER,
): NativeNotification {
  return {
    request: {
      identifier: record.id,
      content: {
        title: record.title,
        body: record.body,
        data: {
          wakeyOwnerId: owner,
          wakeyAt: record.at,
          wakeyKind: record.kind,
          wakeyFingerprint: reminderFingerprint(record),
          ...(record.entryId ? { wakeyEntryId: record.entryId } : {}),
        },
      },
    },
  };
}
const example: ReminderRecord = {
  id: "wakey:task:shower",
  at: clock.now() + 60_000,
  title: "Shower for bed",
  body: "Shift Transition activity is due.",
  kind: "task",
  entryId: "early",
};
async function native() {
  const api = await import("../src/platform/notifications");
  const scope = await import("../src/platform/notificationScope");
  return { ...api, ...scope };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.platform.OS = "ios";
  mocks.rows.clear();
  mocks.received = mocks.responded = null;
  mocks.last = null;
  const permission = { status: "granted", granted: true, ios: { status: 2 } };
  mocks.getPermissionsAsync.mockImplementation(async () => permission);
  mocks.requestPermissionsAsync.mockImplementation(async () => permission);
  mocks.getAllScheduledNotificationsAsync.mockImplementation(async () => [
    ...mocks.rows.values(),
  ]);
  mocks.getPresentedNotificationsAsync.mockResolvedValue([]);
  mocks.dismissNotificationAsync.mockResolvedValue(undefined);
  mocks.cancelScheduledNotificationAsync.mockImplementation(
    async (id: string) => {
      mocks.rows.delete(id);
    },
  );
  mocks.scheduleNotificationAsync.mockImplementation(
    async (request: {
      identifier: string;
      content: Record<string, unknown>;
    }) => {
      mocks.rows.set(request.identifier, request);
      return request.identifier;
    },
  );
  mocks.setNotificationChannelAsync.mockResolvedValue(undefined);
  mocks.addNotificationReceivedListener.mockImplementation(
    (listener: typeof mocks.received) => {
      mocks.received = listener;
      return { remove: mocks.removeReceived };
    },
  );
  mocks.addNotificationResponseReceivedListener.mockImplementation(
    (listener: typeof mocks.responded) => {
      mocks.responded = listener;
      return { remove: mocks.removeResponse };
    },
  );
  mocks.getLastNotificationResponse.mockImplementation(() => mocks.last);
  mocks.clearLastNotificationResponse.mockImplementation(() => {
    mocks.last = null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("native activity notification lifecycle", () => {
  it("delivers opted-in foreground alerts when OS permission is denied without scheduling OS notifications", async () => {
    mocks.getPermissionsAsync.mockResolvedValue({
      status: "denied",
      granted: false,
      ios: { status: 1 },
    });
    vi.setSystemTime(clock.now());
    const currentClock = { now: () => Date.now() };
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const events: DueAlert[] = [];
    const unsubscribe = api.subscribeDueAlerts((alert) => events.push(alert));
    const state = planner();
    const first = desiredReminders(state, currentClock)[0];
    mocks.rows.set("wakey:legacy", {
      identifier: "wakey:legacy",
      content: { data: {} },
    });
    const status = await api.syncReminders(state, currentClock, OWNER);
    expect(status.permission).toBe("denied");
    expect(status.message).toContain(
      "In-app alerts appear while this app is open",
    );
    expect(status.message).toContain(
      "Background alerts need notification permission",
    );
    expect(mocks.rows.size).toBe(0);
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(first.at - currentClock.now());
    expect(events).toEqual([
      expect.objectContaining({
        id: first.id,
        at: first.at,
        interaction: "received",
        fingerprint: reminderFingerprint(first),
      }),
    ]);
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("delivers a due in-app alert once and preserves its pending OS request when the minute refresh wins the timer race", async () => {
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const events: DueAlert[] = [];
    const unsubscribe = api.subscribeDueAlerts((alert) => events.push(alert));
    let now = clock.now();
    const currentClock = { now: () => now };
    const state = planner();
    const first = desiredReminders(state, currentClock)[0];
    await api.syncReminders(state, currentClock, OWNER);
    const writes = mocks.scheduleNotificationAsync.mock.calls.length;
    now = first.at;
    await api.syncReminders(state, currentClock, OWNER);
    expect(events).toEqual([
      expect.objectContaining({
        id: first.id,
        fingerprint: reminderFingerprint(first),
      }),
    ]);
    expect(mocks.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith(
      first.id,
    );
    expect(mocks.scheduleNotificationAsync).toHaveBeenCalledTimes(writes);
    mocks.received!(notification(first));
    expect(events).toHaveLength(1);
    unsubscribe();
  });

  it("drops just-due retained events when the user disables reminders instead of firing them during the save", async () => {
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const listener = vi.fn();
    const unsubscribe = api.subscribeDueAlerts(listener);
    let now = clock.now();
    const currentClock = { now: () => now };
    const state = planner();
    const first = desiredReminders(state, currentClock)[0];
    await api.syncReminders(state, currentClock, OWNER);
    now = first.at;
    await api.syncReminders(
      { ...state, settings: { ...state.settings, remindersEnabled: false } },
      currentClock,
      OWNER,
    );
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
    unsubscribe();
  });
  it("installs the foreground handler on import without prompting for permission", async () => {
    await native();
    expect(mocks.setNotificationHandler).toHaveBeenCalledOnce();
    expect(mocks.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("receives and opens current-owner activities once, rejects stale accounts, and removes listeners", async () => {
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const events: DueAlert[] = [];
    const unsubscribe = api.subscribeDueAlerts((alert) => events.push(alert));
    const item = notification(example);
    mocks.received!(item);
    mocks.received!(item);
    mocks.responded!({ notification: item });
    expect(events.map((alert) => alert.interaction)).toEqual([
      "received",
      "opened",
    ]);
    expect(events[0]).toMatchObject(example);
    api.clearNotificationOwner(OWNER);
    mocks.received!(notification({ ...example, id: "wakey:task:other" }));
    api.activateNotificationOwner(NEXT_OWNER);
    mocks.responded!({ notification: item });
    mocks.received!(notification(example, NEXT_OWNER));
    expect(events).toHaveLength(3);
    unsubscribe();
    expect(mocks.removeReceived).toHaveBeenCalledOnce();
    expect(mocks.removeResponse).toHaveBeenCalledOnce();
  });

  it("suppresses native presentation for foreign, unowned or tampered notifications", async () => {
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const handler =
      mocks.setNotificationHandler.mock.calls[0][0].handleNotification;
    expect(await handler(notification(example))).toMatchObject({
      shouldShowBanner: true,
      shouldPlaySound: true,
    });
    expect(await handler(notification(example, NEXT_OWNER))).toMatchObject({
      shouldShowBanner: false,
      shouldPlaySound: false,
    });
    const tampered = notification(example);
    tampered.request.content.body = "Changed after scheduling";
    expect(await handler(tampered)).toMatchObject({ shouldShowBanner: false });
    api.clearNotificationOwner();
    expect(await handler(notification(example))).toMatchObject({
      shouldShowBanner: false,
    });
  });

  it("handles a cold-start tap after the account is restored, without replaying it on resync", async () => {
    const api = await native();
    mocks.last = { notification: notification(example) };
    const events: DueAlert[] = [];
    const unsubscribe = api.subscribeDueAlerts((alert) => events.push(alert));
    expect(events).toEqual([]);
    api.activateNotificationOwner(OWNER);
    await api.syncReminders(planner(), clock, OWNER);
    await api.syncReminders(planner(), clock, OWNER);
    expect(events).toEqual([
      {
        ...example,
        fingerprint: reminderFingerprint(example),
        interaction: "opened",
      },
    ]);
    expect(mocks.clearLastNotificationResponse).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("cancels an OS scheduling request that finishes after logout before scheduling the next account", async () => {
    const api = await native();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.scheduleNotificationAsync.mockImplementationOnce(
      async (request: {
        identifier: string;
        content: Record<string, unknown>;
      }) => {
        entered();
        await held;
        mocks.rows.set(request.identifier, request);
        return request.identifier;
      },
    );
    api.activateNotificationOwner(OWNER);
    const old = api.syncReminders(planner(), clock, OWNER);
    await started;
    api.clearNotificationOwner(OWNER);
    api.activateNotificationOwner(NEXT_OWNER);
    const next = api.syncReminders(planner(), clock, NEXT_OWNER);
    release();
    await Promise.all([old, next]);
    expect(mocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      mocks.scheduleNotificationAsync.mock.calls[0][0].identifier,
    );
    expect(mocks.rows.size).toBe(desiredReminders(planner(), clock).length);
    for (const row of mocks.rows.values())
      expect((row.content.data as Record<string, unknown>).wakeyOwnerId).toBe(
        NEXT_OWNER,
      );
  });

  it("removes obsolete unowned notifications and replaces identical IDs from an earlier owner", async () => {
    const api = await native();
    const record = desiredReminders(planner(), clock)[0];
    const old = notification(record, NEXT_OWNER).request;
    mocks.rows.set(old.identifier, old);
    mocks.rows.set("wakey:legacy", {
      identifier: "wakey:legacy",
      content: { data: {} },
    });
    api.activateNotificationOwner(OWNER);
    await api.syncReminders(planner(), clock, OWNER);
    expect(mocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      old.identifier,
    );
    expect(mocks.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      "wakey:legacy",
    );
    expect(
      (mocks.rows.get(old.identifier)!.content.data as Record<string, unknown>)
        .wakeyOwnerId,
    ).toBe(OWNER);
  });

  it("preserves the next account when cleanup for a previous owner is queued late", async () => {
    const api = await native();
    mocks.rows.set(
      "wakey:task:old",
      notification({ ...example, id: "wakey:task:old" }).request,
    );
    mocks.rows.set(
      "wakey:task:new",
      notification({ ...example, id: "wakey:task:new" }, NEXT_OWNER).request,
    );
    mocks.getPresentedNotificationsAsync.mockResolvedValue([
      notification({ ...example, id: "wakey:task:shown-old" }),
      notification({ ...example, id: "wakey:task:shown-new" }, NEXT_OWNER),
    ]);
    api.activateNotificationOwner(OWNER);
    const cleanup = api.disableReminders();
    api.activateNotificationOwner(NEXT_OWNER);
    await cleanup;
    expect([...mocks.rows.keys()]).toEqual(["wakey:task:new"]);
    expect(mocks.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith(
      "wakey:task:shown-old",
    );
  });

  it("marks test deliveries with their owner and emits the same in-app due event", async () => {
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const listener = vi.fn();
    const unsubscribe = api.subscribeDueAlerts(listener);
    await api.testNotification();
    const request = mocks.scheduleNotificationAsync.mock.calls[0][0];
    expect(request.content.data).toMatchObject({
      wakeyOwnerId: OWNER,
      wakeyKind: "test",
    });
    mocks.received!({ request });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "wakey:test",
        kind: "test",
        interaction: "received",
      }),
    );
    unsubscribe();
  });

  it("creates the Android channel before an explicit permission request and describes timing limits", async () => {
    mocks.platform.OS = "android";
    const api = await native();
    api.activateNotificationOwner(OWNER);
    const status = await api.requestReminders();
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith(
      "wakey-reminders",
      expect.objectContaining({ importance: 3 }),
    );
    expect(
      mocks.setNotificationChannelAsync.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.requestPermissionsAsync.mock.invocationCallOrder[0]);
    expect(status.message).toContain("Android may delay");
  });
});
