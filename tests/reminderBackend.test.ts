import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  initialState,
  newSettings,
  suppliedProfile,
} from "../src/data/defaults";
import type { AppState, ReminderRecord, Task } from "../src/model";
import { zonedEpoch } from "../src/engine/time";
import { desiredReminders, MAX_WEB_REMINDERS } from "../src/platform/reminders";
import {
  createReminderHandler,
  DUE_GRACE_MS,
  MAX_CONCURRENT_PUSHES,
  SERVER_CACHE_HORIZON_DAYS,
  validPushSubscription,
  type Device,
  type PushSubscriptionData,
  type ReminderDependencies,
} from "../supabase/functions/wakey-reminders/handler";

const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const DEVICE = "30000000-0000-4000-8000-000000000001";
const SESSION = "20000000-0000-4000-8000-000000000001";
const ORIGIN = "https://morecreationapps.github.io";
const subscription: PushSubscriptionData = {
  endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-endpoint",
  keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
};
const config = {
  publicKey: "synthetic-public",
  privateKey: "synthetic-private",
  cronSecret: "synthetic-cron",
};
const task = (changes: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Call dentist",
  kind: "fixed",
  minutes: 15,
  earliest: "2032-08-09T17:00",
  deadline: "2032-08-09T17:15",
  windowStart: "17:00",
  windowEnd: "17:15",
  priority: 1,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: false,
  splittable: false,
  locked: true,
  scheduledStart: "2032-08-09T17:00",
  state: "pending",
  linkedShiftId: "shift-1",
  ...changes,
});
function planner(): AppState {
  const settings = suppliedProfile(newSettings());
  return {
    ...initialState(),
    settings: {
      ...settings,
      timezone: "Europe/London",
      timezoneConfirmed: true,
      onboardingComplete: true,
      remindersEnabled: true,
      reminderCoverageVersion: 1,
      reminderKinds: [
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
      ],
      sleepTarget: 420,
      latency: 30,
      windDown: 60,
      returnMinutes: 20,
      freeMinutes: 0,
      additionalPrepConfirmed: true,
      postWorkMinutes: 30,
      restBed: "23:30",
      restWake: "07:00",
      lateBed: "23:30",
      lateWake: "07:00",
      beforeLateBed: "23:30",
      beforeLateWake: "07:00",
      origins: {
        ...settings.origins,
        timezone: "entered",
        sleepTarget: "entered",
        latency: "entered",
        windDown: "entered",
        arrivalBuffer: "entered",
      },
    },
    entries: [
      {
        id: "rest",
        date: "2032-08-09",
        status: "Rest",
        category: "Custom",
        duty: "",
        start: null,
        end: null,
        timezone: "Europe/London",
        location: "",
        notes: "",
        overtimeMinutes: 0,
        breakMinutes: null,
        paidMinutes: null,
      },
      {
        id: "shift-1",
        date: "2032-08-10",
        status: "Work",
        category: "Late",
        duty: "24L",
        start: "2032-08-10T14:08",
        end: "2032-08-10T22:26",
        timezone: "Europe/London",
        location: "",
        notes: "",
        overtimeMinutes: 0,
        breakMinutes: null,
        paidMinutes: null,
      },
    ],
    tasks: [task()],
  };
}
function harness(
  options: {
    state?: AppState;
    now?: number;
    payload?: boolean;
    cacheStale?: boolean;
    subscription?: PushSubscriptionData;
  } = {},
) {
  let now = options.now ?? zonedEpoch("2032-08-09T17:00", "Europe/London");
  const state = options.state ?? planner();
  const device: Device = {
    deviceId: DEVICE,
    userId: OWNER,
    subscription: options.subscription ?? subscription,
    revision: "a".repeat(64),
    snapshotRevision: 7,
    cachedRevision: 7,
    schedule: [],
    ...(options.payload === false ? {} : { payload: JSON.stringify(state) }),
  };
  const deliveries = new Set<string>();
  const push = vi.fn(
    async (
      _subscription: PushSubscriptionData,
      _payload: string,
      _config: typeof config,
    ) => {},
  );
  const service = vi.fn(
    async (action: string, data: Record<string, unknown> = {}) => {
      if (action === "config") return config;
      if (action === "devices") return [{ ...device }];
      if (action === "device")
        return data.userId === OWNER && data.deviceId === DEVICE
          ? { ...device }
          : null;
      if (action === "cache") {
        if (options.cacheStale) return { updated: false };
        device.schedule = data.reminders as ReminderRecord[];
        device.cachedRevision = Number(data.snapshotRevision);
        if (data.revision !== undefined)
          device.revision = String(data.revision);
        return { updated: true };
      }
      if (action === "claim") {
        if (
          !state.settings.remindersEnabled ||
          data.snapshotRevision !== device.snapshotRevision
        )
          return false;
        const fingerprint = String(data.fingerprint);
        if (deliveries.has(fingerprint)) return false;
        deliveries.add(fingerprint);
        return true;
      }
      if (action === "status")
        return {
          registered: true,
          scheduled: device.schedule.length,
          through: device.schedule.at(-1)?.at ?? null,
          revision: device.revision,
        };
      return true;
    },
  );
  const deps: ReminderDependencies = {
    now: () => now,
    identity: vi.fn(async (token) =>
      token === "verified" ? { id: OWNER, sessionId: SESSION } : null,
    ),
    service: service as ReminderDependencies["service"],
    generateKeys: () => ({
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    }),
    push,
    digest: async (value) => createHash("sha256").update(value).digest("hex"),
  };
  const handler = createReminderHandler(deps);
  const request = async (
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) => {
    const result = await handler(
      new Request("https://example.invalid/functions/v1/wakey-reminders", {
        method,
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        ...(method === "POST"
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      }),
    );
    return {
      status: result.status,
      body: await result.json(),
      headers: result.headers,
    };
  };
  const dispatch = () =>
    request({ action: "dispatch" }, { "x-wakey-cron": config.cronSecret });
  return {
    request,
    dispatch,
    push,
    service,
    deps,
    device,
    state,
    deliveries,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("authenticated account-driven web reminder handler", () => {
  it("rejects missing, invalid and cross-owner identities without touching device storage", async () => {
    const h = harness();
    for (const headers of [{}, { authorization: "Bearer invalid" }] as Record<
      string,
      string
    >[])
      expect(
        (await h.request({ action: "status", deviceId: DEVICE }, headers))
          .status,
      ).toBe(401);
    expect(
      (
        await h.request(
          { action: "sync", deviceId: DEVICE, ownerId: OTHER },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(401);
    expect(h.service).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
  it("checks browser origin, body size, method and preflight before any user access", async () => {
    const h = harness();
    expect(
      (
        await h.request(
          { action: "status" },
          { origin: "https://untrusted.invalid" },
        )
      ).status,
    ).toBe(403);
    expect((await h.request("x".repeat(16_385))).status).toBe(413);
    expect((await h.request({}, {}, "GET")).status).toBe(405);
    const options = await h.request({}, {}, "OPTIONS");
    expect(options.status).toBe(200);
    expect(options.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(h.deps.identity).not.toHaveBeenCalled();
  });
  it("never exposes private VAPID or cron credentials through the public key action", async () => {
    const h = harness();
    const result = await h.request(
      { action: "public-key" },
      { authorization: "Bearer verified" },
    );
    expect(result).toMatchObject({
      status: 200,
      body: { publicKey: config.publicKey },
    });
    expect(JSON.stringify(result.body)).not.toContain(config.privateKey);
    expect(JSON.stringify(result.body)).not.toContain(config.cronSecret);
  });
  it("requires the server-only cron credential; a verified user JWT cannot dispatch", async () => {
    const h = harness();
    expect(
      (
        await h.request(
          { action: "dispatch" },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(401);
    expect(
      (await h.request({ action: "dispatch" }, { "x-wakey-cron": "wrong" }))
        .status,
    ).toBe(401);
    expect(h.service.mock.calls.some(([action]) => action === "devices")).toBe(
      false,
    );
    expect(h.push).not.toHaveBeenCalled();
  });
  it("derives cached reminders from the stored account snapshot and ignores client-supplied tasks", async () => {
    const h = harness();
    const fake = {
      id: "client-forged",
      title: "Forged",
      body: "Forged",
      kind: "task",
      at: 1,
    };
    expect(
      (
        await h.request(
          {
            action: "sync",
            deviceId: DEVICE,
            revision: "b".repeat(64),
            reminders: [fake],
          },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(200);
    const cache = h.service.mock.calls.find(
      ([action]) => action === "cache",
    )?.[1];
    expect(cache?.reminders).toEqual(
      desiredReminders(
        h.state,
        { now: () => h.deps.now() - DUE_GRACE_MS },
        { max: MAX_WEB_REMINDERS, horizonDays: SERVER_CACHE_HORIZON_DAYS },
      ),
    );
    expect(cache).toMatchObject({
      deviceId: DEVICE,
      userId: OWNER,
      snapshotRevision: 7,
      revision: "b".repeat(64),
      client: true,
    });
    expect(
      h.device.schedule.some((record) => record.id === "client-forged"),
    ).toBe(false);
  });
  it("sends a dated due task once across repeated minute dispatches with a stable fingerprint", async () => {
    const h = harness();
    const first = await h.dispatch();
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(h.push.mock.calls[0][1]);
    expect(sent).toMatchObject({
      ownerId: OWNER,
      deviceId: DEVICE,
      revision: "a".repeat(64),
      reminder: { title: "Call dentist", at: h.deps.now() },
    });
    expect(sent.fingerprint).toBeTruthy();
    expect((await h.dispatch()).body.accepted).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(1);
  });
  it("bounds the server cache to one day while retaining a longer foreground/native horizon", async () => {
    const h = harness();
    await h.dispatch();
    const fullHorizon = desiredReminders(
      h.state,
      { now: () => h.deps.now() - DUE_GRACE_MS },
      { max: MAX_WEB_REMINDERS },
    );
    expect(h.device.schedule.length).toBeLessThan(fullHorizon.length);
    expect(
      h.device.schedule.every(
        (record) => record.at <= h.deps.now() - DUE_GRACE_MS + 86_400_000,
      ),
    ).toBe(true);
    expect(
      h.device.schedule.some((record) => record.title === "Planned finish"),
    ).toBe(false);
    expect(
      fullHorizon.some((record) => record.title === "Planned finish"),
    ).toBe(true);
  });
  it("renews the closed-app cache after 12 hours and delivers a later activity without a browser sync", async () => {
    const h = harness();
    await h.dispatch();
    expect(
      h.device.schedule.some((record) => record.title === "Planned finish"),
    ).toBe(false);
    // A fresh, unchanged server cache can be read without its account payload.
    h.device.payload = null;
    h.setNow(zonedEpoch("2032-08-09T18:00", "Europe/London"));
    await h.dispatch();
    expect(
      h.service.mock.calls.filter(([action]) => action === "cache"),
    ).toHaveLength(1);
    // SQL returns the protected account payload when its cache is 12h old.
    h.device.payload = JSON.stringify(h.state);
    h.setNow(zonedEpoch("2032-08-10T05:00", "Europe/London"));
    await h.dispatch();
    expect(
      h.device.schedule.some((record) => record.title === "Planned finish"),
    ).toBe(true);
    h.device.payload = null;
    h.setNow(zonedEpoch("2032-08-10T22:26", "Europe/London"));
    await h.dispatch();
    expect(
      h.push.mock.calls.some(
        (call) => JSON.parse(call[1]).reminder.title === "Planned finish",
      ),
    ).toBe(true);
    expect(
      h.service.mock.calls.some(
        ([action, data]) => action === "cache" && data?.client,
      ),
    ).toBe(false);
  });
  it.each(["completed", "skipped", "deferred"] as const)(
    "omits a %s task from due delivery",
    async (taskState) => {
      const state = planner();
      state.tasks[0].state = taskState;
      const h = harness({ state });
      await h.dispatch();
      expect(h.push).not.toHaveBeenCalled();
    },
  );
  it("does not send a deleted, moved, overlapping or opted-out task", async () => {
    const deleted = planner();
    deleted.tasks = [];
    const moved = planner();
    moved.tasks[0].scheduledStart = "2032-08-09T18:00";
    moved.tasks[0].earliest = "2032-08-09T18:00";
    moved.tasks[0].deadline = "2032-08-09T18:15";
    const conflict = planner();
    conflict.tasks.unshift(
      task({
        id: "conflict",
        title: "Existing appointment",
        minutes: 30,
        scheduledStart: "2032-08-09T16:50",
        earliest: "2032-08-09T16:50",
        deadline: "2032-08-09T17:20",
        windowStart: "16:50",
        windowEnd: "17:20",
      }),
    );
    const off = planner();
    off.settings.remindersEnabled = false;
    for (const state of [deleted, moved, conflict, off]) {
      const h = harness({ state });
      await h.dispatch();
      expect(h.push).not.toHaveBeenCalled();
    }
  });
  it("skips a changed snapshot revision when a simultaneous account save defeats cache publication", async () => {
    const h = harness({ cacheStale: true });
    const result = await h.dispatch();
    expect(result.body.accepted).toBe(0);
    expect(h.push).not.toHaveBeenCalled();
  });
  it("does not send future, expired, or unrefreshed cached events", async () => {
    const due = zonedEpoch("2032-08-09T17:00", "Europe/London");
    for (const at of [due + 1, due - DUE_GRACE_MS - 1]) {
      const h = harness({ payload: false });
      h.device.schedule = [
        {
          id: "wakey:synthetic",
          at,
          title: "Synthetic",
          body: "Synthetic",
          kind: "task",
        },
      ];
      await h.dispatch();
      expect(h.push).not.toHaveBeenCalled();
    }
    const h = harness({ payload: false });
    h.device.cachedRevision = 6;
    h.device.schedule = [
      {
        id: "wakey:synthetic",
        at: due,
        title: "Synthetic",
        body: "Synthetic",
        kind: "task",
      },
    ];
    await h.dispatch();
    expect(h.push).not.toHaveBeenCalled();
  });
  it("validates subscriptions and revisions before registering or syncing a device", async () => {
    const h = harness();
    expect(
      (
        await h.request(
          {
            action: "subscribe",
            deviceId: DEVICE,
            subscription: {
              ...subscription,
              endpoint: "https://localhost/private",
            },
          },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          { action: "sync", deviceId: DEVICE, revision: "invalid" },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          { action: "status", deviceId: "invalid" },
          { authorization: "Bearer verified" },
        )
      ).status,
    ).toBe(400);
    expect(h.service).not.toHaveBeenCalled();
  });
  it.each([404, 410])(
    "disables expired subscriptions returned as HTTP %i",
    async (statusCode) => {
      const h = harness();
      h.push.mockRejectedValueOnce({ statusCode });
      const result = await h.dispatch();
      expect(result.body.failed).toBe(1);
      expect(h.service).toHaveBeenCalledWith("disable", {
        deviceId: DEVICE,
        userId: OWNER,
      });
      expect(
        h.service.mock.calls.some(
          ([action, data]) =>
            action === "outcome" && data?.outcome === "failed",
        ),
      ).toBe(true);
    },
  );
  it("a failed provider send remains claimed so an uncertain retry cannot duplicate it", async () => {
    const h = harness();
    h.push.mockRejectedValueOnce(new Error("timeout"));
    await h.dispatch();
    await h.dispatch();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.deliveries.size).toBe(1);
  });
  it("deduplicates simultaneous dispatcher retries atomically before calling the push provider", async () => {
    const h = harness();
    const results = await Promise.all([
      h.dispatch(),
      h.dispatch(),
      h.dispatch(),
    ]);
    expect(
      results.reduce((total, result) => total + result.body.accepted, 0),
    ).toBe(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.deliveries.size).toBe(1);
  });
  it("delivers every due cached record beyond the native 60-reminder scheduling cap", async () => {
    const h = harness({ payload: false });
    h.device.schedule = Array.from({ length: 75 }, (_, index) => ({
      id: `wakey:synthetic:${index}`,
      at: h.deps.now(),
      title: `Synthetic activity ${index}`,
      body: "Synthetic date and time",
      kind: "activity",
    }));
    expect((await h.dispatch()).body.accepted).toBe(75);
    expect(h.push).toHaveBeenCalledTimes(75);
    expect(h.deliveries.size).toBe(75);
    expect((await h.dispatch()).body.accepted).toBe(0);
  });
  it("sends bursts through at most four simultaneous provider requests without losing queued records", async () => {
    const h = harness({ payload: false });
    h.device.schedule = Array.from({ length: 11 }, (_, index) => ({
      id: `wakey:parallel:${index}`,
      at: h.deps.now(),
      title: `Synthetic activity ${index}`,
      body: "Synthetic date and time",
      kind: "activity",
    }));
    let active = 0;
    let maximum = 0;
    const unblock: Array<() => void> = [];
    h.push.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => unblock.push(resolve));
      active--;
    });
    const dispatching = h.dispatch();
    await vi.waitFor(() => expect(active).toBe(MAX_CONCURRENT_PUSHES));
    expect(h.push).toHaveBeenCalledTimes(4);
    while (h.push.mock.calls.length < 11) {
      unblock.splice(0).forEach((resolve) => resolve());
      const expected = Math.min(h.push.mock.calls.length + 4, 11);
      await vi.waitFor(() => expect(h.push.mock.calls.length).toBe(expected));
    }
    unblock.splice(0).forEach((resolve) => resolve());
    expect((await dispatching).body.accepted).toBe(11);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(h.deliveries.size).toBe(11);
    expect((await h.dispatch()).body.accepted).toBe(0);
  });
  it("rechecks stale-alert grace before claiming queued records after slow provider requests", async () => {
    const h = harness({ payload: false });
    const due = h.deps.now();
    h.device.schedule = Array.from({ length: 8 }, (_, index) => ({
      id: `wakey:slow:${index}`,
      at: due,
      title: `Synthetic activity ${index}`,
      body: "Synthetic date and time",
      kind: "activity",
    }));
    const unblock: Array<() => void> = [];
    h.push.mockImplementation(async () => {
      await new Promise<void>((resolve) => unblock.push(resolve));
    });
    const dispatching = h.dispatch();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledTimes(4));
    h.setNow(due + DUE_GRACE_MS + 1);
    unblock.splice(0).forEach((resolve) => resolve());
    expect((await dispatching).body.accepted).toBe(4);
    expect(h.push).toHaveBeenCalledTimes(4);
    expect(h.deliveries.size).toBe(4);
  });
  it("tests only the verified user's registered device without consuming the real reminder ledger", async () => {
    const h = harness();
    expect((await h.request({ action: "test", deviceId: DEVICE })).status).toBe(
      401,
    );
    const missing = await h.request(
      { action: "test", deviceId: OTHER },
      { authorization: "Bearer verified" },
    );
    expect(missing.status).toBe(400);
    expect(h.push).not.toHaveBeenCalled();
    const result = await h.request(
      { action: "test", deviceId: DEVICE },
      { authorization: "Bearer verified" },
    );
    expect(result.status).toBe(200);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.deliveries.size).toBe(0);
    expect(result.body.message).toContain("accepted");
  });
});

describe("Web Push endpoint SSRF guard", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/id",
    "https://web.push.apple.com/id",
    "https://updates.push.services.mozilla.com/wpush/v2/id",
    "https://eu.push.services.mozilla.com/id",
    "https://wns.notify.windows.com/id",
  ])("allows a recognised HTTPS provider: %s", (endpoint) => {
    expect(validPushSubscription({ ...subscription, endpoint })).toBe(true);
  });
  it.each([
    "http://fcm.googleapis.com/id",
    "https://fcm.googleapis.com:444/id",
    "https://user:pass@fcm.googleapis.com/id",
    "https://fcm.googleapis.com.attacker.invalid/id",
    "https://localhost/id",
    "https://127.0.0.1/id",
    "https://[::1]/id",
    "https://169.254.169.254/latest/meta-data",
    "https://attackerpush.services.mozilla.com/id",
    "https://notify.windows.com.attacker.invalid/id",
    "not-a-url",
  ])("rejects an untrusted endpoint: %s", (endpoint) => {
    expect(validPushSubscription({ ...subscription, endpoint })).toBe(false);
  });
  it("rejects absent or malformed encryption keys and oversized endpoints", () => {
    expect(validPushSubscription(null)).toBe(false);
    expect(
      validPushSubscription({
        ...subscription,
        keys: { p256dh: "bad", auth: "bad" },
      }),
    ).toBe(false);
    expect(
      validPushSubscription({
        ...subscription,
        endpoint: subscription.endpoint + "a".repeat(4096),
      }),
    ).toBe(false);
  });
});
