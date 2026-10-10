import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import type { ReminderRecord } from "../src/model";
import {
  createWebReminderController,
  DUE_ALERT_GRACE_MS,
  type DeliveryLedger,
  vapidKeyBytes,
  webAppRoot,
} from "../src/platform/webReminders";

const remote = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/platform/reminderRemote", () => ({
  invokeReminderRemote: remote.invoke,
}));

const record = (id = "wakey:task:clothes", at = 10_000): ReminderRecord => ({
  id,
  at,
  title: "Lay out clothes",
  body: "Your preparation task is due.",
  kind: "task",
});
function foreground() {
  let now = 0;
  let currentOwner = "account-a";
  const ledgers = new Map<string, DeliveryLedger>();
  const emitted: ReminderRecord[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const controller = createWebReminderController({
    now: () => now,
    setTimer(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
    isCurrent: (owner) => owner === currentOwner,
    readLedger: (owner) => ledgers.get(owner) ?? {},
    writeLedger: (owner, ledger) => {
      ledgers.set(owner, ledger);
    },
    emit: (alert) => {
      emitted.push(alert);
    },
  });
  return {
    controller,
    emitted,
    timers,
    ledgers,
    setTime: (time: number) => {
      now = time;
    },
    setOwner: (owner: string) => {
      currentOwner = owner;
    },
    run() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

describe("foreground web due alerts", () => {
  it("alerts once at the due instant and suppresses timer/push retries and reload replay", () => {
    const f = foreground();
    const task = record();
    f.controller.replace("account-a", [task]);
    expect(f.emitted).toEqual([]);
    f.setTime(task.at - 1);
    f.run();
    expect(f.emitted).toEqual([]);
    f.setTime(task.at);
    f.run();
    expect(f.emitted.map((alert) => alert.id)).toEqual([task.id]);
    expect(f.controller.receive("account-a", task)).toBe(false);
    f.controller.replace("account-a", [task]);
    expect(f.emitted).toHaveLength(1);
    expect(f.controller.pending()).toEqual([]);
  });
  it("cancels removed tasks and moves edited tasks to the new due instant", () => {
    const f = foreground();
    f.controller.replace("account-a", [
      record("wakey:removed", 5_000),
      record("wakey:moved", 10_000),
    ]);
    f.controller.replace("account-a", [record("wakey:moved", 20_000)]);
    f.setTime(10_000);
    f.run();
    expect(f.emitted).toEqual([]);
    f.setTime(20_000);
    f.run();
    expect(f.emitted.map((alert) => alert.id)).toEqual(["wakey:moved"]);
  });
  it("does not lose a due reminder when an unchanged-plan minute refresh wins the timer race", () => {
    const f = foreground();
    const due = record();
    f.controller.replace("account-a", [due]);
    f.setTime(due.at);
    f.controller.replace("account-a", [], { retainDue: true });
    expect(f.emitted.map((alert) => alert.id)).toEqual([due.id]);
    f.run();
    expect(f.emitted).toHaveLength(1);
  });
  it("does not retain a due reminder deleted in a changed saved plan", () => {
    const f = foreground();
    f.controller.replace("account-a", [record()]);
    f.setTime(10_000);
    f.controller.replace("account-a", [], { retainDue: false });
    expect(f.emitted).toEqual([]);
  });
  it("suppresses callbacks after logout and messages for a different owner", () => {
    const f = foreground();
    const task = record();
    f.controller.replace("account-a", [task]);
    const stale = [...f.timers.values()][0];
    f.controller.clear();
    f.setOwner("account-b");
    f.setTime(task.at);
    stale();
    expect(f.controller.receive("account-a", task)).toBe(false);
    expect(f.emitted).toEqual([]);
    f.controller.replace("account-b", [task]);
    expect(f.emitted).toHaveLength(1);
    expect(f.ledgers.has("account-a")).toBe(false);
    expect(f.ledgers.has("account-b")).toBe(true);
  });
  it("withholds old reminders after suspension and allows only a short due grace window", () => {
    const f = foreground();
    const due = record();
    f.controller.replace("account-a", [due]);
    f.setTime(due.at + DUE_ALERT_GRACE_MS + 1);
    f.controller.refresh();
    expect(f.emitted).toEqual([]);
    const recent = record("wakey:recent", 200_000);
    f.controller.replace("account-a", [recent]);
    f.setTime(recent.at + 30_000);
    f.controller.refresh();
    expect(f.emitted.map((alert) => alert.id)).toEqual([recent.id]);
  });
  it("sorts simultaneous items deterministically, deduplicates IDs and never mutates intentions", () => {
    const f = foreground();
    const intentions = [
      record("wakey:b"),
      record("wakey:a"),
      record("wakey:b"),
    ];
    const before = JSON.stringify(intentions);
    f.controller.replace("account-a", intentions);
    f.setTime(10_000);
    f.run();
    expect(f.emitted.map((alert) => alert.id)).toEqual(["wakey:a", "wakey:b"]);
    expect(JSON.stringify(intentions)).toBe(before);
  });
  it("bounds timers to a minute so foreground clock changes get reconciled", () => {
    const delays: number[] = [];
    createWebReminderController({
      now: () => 0,
      setTimer: (_callback, delay) => {
        delays.push(delay);
        return 1;
      },
      clearTimer: () => undefined,
      isCurrent: () => true,
      readLedger: () => ({}),
      writeLedger: () => undefined,
      emit: () => undefined,
    }).replace("account-a", [record("wakey:far", 10_000_000)]);
    expect(delays).toEqual([60_000]);
  });
});

describe("web install notification identity", () => {
  it("resolves the worker and icons inside the GitHub project root and local root", () => {
    const pages = webAppRoot(
      "https://morecreationapps.github.io/wakey-wakey/",
      "./manifest.webmanifest",
    );
    expect(new URL("service-worker.js", pages).href).toBe(
      "https://morecreationapps.github.io/wakey-wakey/service-worker.js",
    );
    expect(
      webAppRoot("http://localhost:8081/", "./manifest.webmanifest").href,
    ).toBe("http://localhost:8081/");
    expect(
      webAppRoot(
        "https://morecreationapps.github.io/wakey-wakey/?screen=settings",
        "./manifest.webmanifest",
      ).pathname,
    ).toBe("/wakey-wakey/");
  });
  it("does not allow a manifest on a different origin to change worker scope", () => {
    expect(
      webAppRoot(
        "https://morecreationapps.github.io/wakey-wakey/",
        "https://other.invalid/manifest.webmanifest",
      ).origin,
    ).toBe("https://morecreationapps.github.io");
  });
  it("converts and validates a public P-256 VAPID key", () => {
    const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString(
      "base64url",
    );
    expect(vapidKeyBytes(key)).toEqual(
      Uint8Array.from([4, ...Array(64).fill(1)]),
    );
    expect(() => vapidKeyBytes("secret token!")).toThrow(
      "Invalid push public key",
    );
    expect(() => vapidKeyBytes("AQID")).toThrow("Invalid push public key");
  });
});

async function browserAdapter(
  permission: "default" | "granted" | "denied" = "granted",
  push = true,
) {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  remote.invoke.mockReset();
  const storage = new Map<string, string>();
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const owner = "11111111-1111-4111-8111-111111111111";
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(64, 1),
  ]).toString("base64url");
  const subscription = {
    toJSON: () => ({
      endpoint: "https://push.invalid/subscription",
      keys: { p256dh: "public", auth: "opaque" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  class Channel {
    port1 = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: () => undefined,
    };
    port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
  }
  const registration = {
    active: {
      postMessage: (
        message: Record<string, unknown>,
        ports: { reply(data: unknown): void }[],
      ) => {
        messages.push(message);
        ports[0].reply({ ok: true });
      },
    },
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async () => subscription),
    },
  };
  const serviceWorker = {
    register: vi.fn(async () => {
      calls.push("register");
      return registration;
    }),
    getRegistration: vi.fn(async () => registration),
    addEventListener: vi.fn(),
  };
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      calls.push("permission");
      return permission;
    }),
  };
  const window = {
    isSecureContext: true,
    location: { href: "https://morecreationapps.github.io/wakey-wakey/" },
    addEventListener: vi.fn(),
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    ...(push ? { Notification: notification, PushManager: {} } : {}),
  };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", {
    querySelector: () => ({ getAttribute: () => "./manifest.webmanifest" }),
    addEventListener: vi.fn(),
    visibilityState: "visible",
  });
  vi.stubGlobal("navigator", {
    serviceWorker,
    userAgent: "Browser",
    maxTouchPoints: 0,
  });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("MessageChannel", Channel);
  vi.stubGlobal("crypto", webcrypto);
  remote.invoke.mockImplementation(async (payload: Record<string, unknown>) =>
    payload.action === "public-key"
      ? { publicKey }
      : { scheduled: 0, through: null },
  );
  const scopes = await import("../src/platform/notificationScope");
  scopes.activateNotificationOwner(owner);
  const adapter = await import("../src/platform/notifications.web");
  return {
    adapter,
    scopes,
    owner,
    calls,
    messages,
    serviceWorker,
    notification,
    registration,
  };
}
describe("web platform opt-in and account lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("requests browser permission only from the explicit action before registration or remote work", async () => {
    const h = await browserAdapter();
    await h.adapter.notificationStatus();
    expect(h.notification.requestPermission).not.toHaveBeenCalled();
    const status = await h.adapter.requestReminders();
    expect(h.calls).toEqual(["permission", "register"]);
    expect(status.supported).toBe(true);
    expect(status.permission).toBe("granted");
    expect(h.serviceWorker.register).toHaveBeenCalledWith(
      "https://morecreationapps.github.io/wakey-wakey/service-worker.js",
      expect.objectContaining({ scope: "/wakey-wakey/" }),
    );
    expect(h.messages).toMatchObject([
      { type: "wakey-reminder-owner", ownerId: h.owner },
    ]);
    expect(remote.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "subscribe", ownerId: h.owner }),
    );
  });
  it("refreshes an unchanged active registration once after 24 hours without writing on every minute refresh", async () => {
    const h = await browserAdapter();
    await h.adapter.requestReminders();
    const { initialState } = await import("../src/data/defaults");
    const state = initialState();
    state.settings = {
      ...state.settings,
      remindersEnabled: true,
      onboardingComplete: true,
      timezone: "Europe/London",
      timezoneConfirmed: true,
    };
    const syncCalls = () =>
      remote.invoke.mock.calls.filter(([payload]) => payload.action === "sync")
        .length;
    await h.adapter.syncReminders(state, undefined, h.owner);
    expect(syncCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.adapter.syncReminders(state, undefined, h.owner);
    expect(syncCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 60_000 - 1);
    await h.adapter.syncReminders(state, undefined, h.owner);
    expect(syncCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await h.adapter.syncReminders(state, undefined, h.owner);
    expect(syncCalls()).toBe(2);
    await h.adapter.syncReminders(state, undefined, h.owner);
    expect(syncCalls()).toBe(2);
  });
  it("still delivers an in-app test when OS permission is denied, without claiming background delivery", async () => {
    const h = await browserAdapter("denied");
    const status = await h.adapter.requestReminders();
    const alerts: ReminderRecord[] = [];
    h.adapter.subscribeDueAlerts((alert) => alerts.push(alert));
    await h.adapter.testNotification();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alerts).toMatchObject([{ id: "wakey:test", kind: "test" }]);
    expect(status.permission).toBe("denied");
    expect(status.message).toContain("permission is denied");
    expect(remote.invoke).not.toHaveBeenCalled();
    await h.adapter.disableReminders();
    expect(remote.invoke).not.toHaveBeenCalled();
  });
  it("uses the successful server push as the only test alert rather than adding a second foreground test", async () => {
    const h = await browserAdapter();
    await h.adapter.requestReminders();
    const alerts: ReminderRecord[] = [];
    h.adapter.subscribeDueAlerts((alert) => alerts.push(alert));
    const requested = await h.adapter.testNotification();
    expect(requested.message).toContain("push service accepted");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alerts).toEqual([]);
    const handler = h.serviceWorker.addEventListener.mock.calls.find(
      (call) => call[0] === "message",
    )?.[1] as (event: { data: unknown }) => void;
    const payload = {
      type: "wakey-reminder-due",
      ownerId: h.owner,
      deviceId: h.messages[0].deviceId,
      reminder: { ...record("wakey:test:server", Date.now()), kind: "test" },
    };
    handler({ data: payload });
    handler({ data: payload });
    expect(alerts).toMatchObject([{ id: "wakey:test:server", kind: "test" }]);
    expect(alerts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alerts).toHaveLength(1);
  });
  it("schedules one foreground fallback test only when the server test request fails", async () => {
    const h = await browserAdapter();
    await h.adapter.requestReminders();
    const alerts: ReminderRecord[] = [];
    h.adapter.subscribeDueAlerts((alert) => alerts.push(alert));
    remote.invoke.mockRejectedValueOnce(new Error("Push service unavailable"));
    const requested = await h.adapter.testNotification();
    expect(requested.message).toContain("push test request failed");
    expect(requested.message).toContain("Push service unavailable");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(alerts).toMatchObject([{ id: "wakey:test", kind: "test" }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alerts).toHaveLength(1);
  });
  it("supports opt-in in-app alerts without Notification or PushManager", async () => {
    const h = await browserAdapter("default", false);
    const status = await h.adapter.requestReminders();
    expect(status.supported).toBe(true);
    expect(status.permission).toBe("in-app-only");
    expect(h.notification.requestPermission).not.toHaveBeenCalled();
    expect(remote.invoke).not.toHaveBeenCalled();
  });
  it("does not finish an old permission request after the same account starts a new session", async () => {
    const h = await browserAdapter();
    let finish!: (permission: "granted") => void;
    h.notification.requestPermission.mockImplementationOnce(
      () =>
        new Promise<"granted">((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.adapter.requestReminders();
    h.scopes.clearNotificationOwner();
    h.scopes.activateNotificationOwner(h.owner);
    finish("granted");
    await pending;
    expect(remote.invoke).not.toHaveBeenCalled();
    expect(h.serviceWorker.register).not.toHaveBeenCalled();
    expect((await h.adapter.notificationStatus()).message).toContain(
      "In-app due alerts are off",
    );
  });
  it("cancels a pending in-app test immediately at logout and fences the previous owner's routing", async () => {
    const h = await browserAdapter();
    await h.adapter.requestReminders();
    const alerts: ReminderRecord[] = [];
    h.adapter.subscribeDueAlerts((alert) => alerts.push(alert));
    remote.invoke.mockRejectedValueOnce(new Error("Push test unavailable"));
    await h.adapter.testNotification();
    h.scopes.clearNotificationOwner();
    await h.adapter.disableReminders();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alerts).toEqual([]);
    expect(h.messages.at(-1)).toMatchObject({ ownerId: null });
    expect(remote.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "disable", ownerId: h.owner }),
    );
  });
});

/** Minimal IndexedDB/worker harness exercises the actual deployed JavaScript. */
function workerHarness() {
  let active: unknown = null;
  let now = 10_000;
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const posted: unknown[] = [];
  const focused = vi.fn(async () => client);
  const opened = vi.fn(async () => client);
  const client = {
    url: "https://morecreationapps.github.io/wakey-wakey/",
    focus: focused,
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  };
  const indexedDB = {
    open() {
      const request: Record<string, any> = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            const transaction: Record<string, any> = {};
            transaction.objectStore = () => ({
              get() {
                return operation(false);
              },
              put(value: unknown) {
                active = value;
                return operation(true);
              },
            });
            function operation(write: boolean) {
              const query: Record<string, any> = {};
              queueMicrotask(() => {
                query.result = write ? "active" : active;
                query.onsuccess?.();
                transaction.oncomplete?.();
              });
              return query;
            }
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
  const self = {
    registration: {
      scope: "https://morecreationapps.github.io/wakey-wakey/",
      getNotifications: async () => [],
      showNotification: async (
        title: string,
        options: Record<string, unknown>,
      ) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [client],
      openWindow: opened,
    },
    skipWaiting: async () => undefined,
    addEventListener: (
      type: string,
      handler: (event: Record<string, unknown>) => void,
    ) => {
      handlers.set(type, handler);
    },
  };
  vm.runInNewContext(
    readFileSync(
      new URL("../public/service-worker.js", import.meta.url),
      "utf8",
    ),
    {
      self,
      indexedDB,
      URL,
      Date: class extends Date {
        static now() {
          return now;
        }
      },
    },
  );
  async function fire(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
  }
  return {
    shown,
    posted,
    focused,
    opened,
    setTime: (time: number) => {
      now = time;
    },
    owner: async (
      ownerId: string | null,
      revision = "rev-1",
      source = client.url,
    ) =>
      fire("message", {
        source: { url: source },
        data: {
          type: "wakey-reminder-owner",
          ownerId,
          deviceId: ownerId ? "device-1" : null,
          revision,
        },
        ports: [],
      }),
    push: async (payload: unknown) =>
      fire("push", { data: { json: () => payload } }),
    click: async (data: unknown) =>
      fire("notificationclick", { notification: { data, close: vi.fn() } }),
  };
}
const pushPayload = (overrides: Record<string, unknown> = {}) => ({
  ownerId: "account-a",
  deviceId: "device-1",
  revision: "rev-1",
  reminder: record(),
  ...overrides,
});

describe("service worker push delivery", () => {
  afterEach(() => vi.restoreAllMocks());
  it("shows a visible push notification with the branded scoped icon and forwards it to the app", async () => {
    const h = workerHarness();
    await h.owner("account-a");
    await h.push(pushPayload());
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].title).toBe("Lay out clothes");
    expect(h.shown[0].options.icon).toBe(
      "https://morecreationapps.github.io/wakey-wakey/icon-192.png",
    );
    expect(h.shown[0].options.renotify).toBe(false);
    expect(h.posted).toMatchObject([
      { type: "wakey-reminder-due", ownerId: "account-a" },
    ]);
  });
  it("rejects a previous account, mismatched revision/device and payload delayed beyond grace", async () => {
    const h = workerHarness();
    await h.owner("account-a");
    await h.push(pushPayload({ ownerId: "account-b" }));
    await h.push(pushPayload({ deviceId: "device-other" }));
    await h.push(pushPayload({ revision: "rev-old" }));
    h.setTime(10_000 + DUE_ALERT_GRACE_MS + 1);
    await h.push(pushPayload());
    expect(h.shown).toEqual([]);
  });
  it("ignores an owner-routing command from outside the app and clears routing on logout", async () => {
    const h = workerHarness();
    await h.owner("account-a", "rev-1", "https://other.invalid/");
    await h.push(pushPayload());
    expect(h.shown).toEqual([]);
    await h.owner("account-a");
    await h.owner(null);
    await h.push(pushPayload());
    expect(h.shown).toEqual([]);
  });
  it("focuses the app when clicked only if the notification still belongs to the active account", async () => {
    const h = workerHarness();
    await h.owner("account-a");
    await h.push(pushPayload());
    await h.click(h.shown[0].options.data);
    expect(h.focused).toHaveBeenCalledOnce();
    expect(h.opened).not.toHaveBeenCalled();
    expect(h.posted.at(-1)).toMatchObject({ type: "wakey-reminder-open" });
    await h.owner("account-b");
    await h.click(h.shown[0].options.data);
    expect(h.focused).toHaveBeenCalledOnce();
  });
  it("discards invalid payloads and never accepts an arbitrary click navigation URL", async () => {
    const h = workerHarness();
    await h.owner("account-a");
    await h.push(
      pushPayload({
        reminder: { ...record(), id: "external", title: "Unexpected" },
      }),
    );
    expect(h.shown).toEqual([]);
    await h.push(pushPayload());
    await h.click({
      ...(h.shown[0].options.data as object),
      url: "https://other.invalid/",
    });
    expect(h.focused).toHaveBeenCalledOnce();
    expect(h.opened).not.toHaveBeenCalled();
  });
});
