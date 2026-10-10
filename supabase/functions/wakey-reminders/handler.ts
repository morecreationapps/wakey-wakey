import { parseBackup } from "../../../src/data/backup";
import {
  desiredReminders,
  MAX_WEB_REMINDERS,
  reminderFingerprint,
} from "../../../src/platform/reminders";
import type { ReminderRecord } from "../../../src/model";

type Data = Record<string, unknown>;
export type Device = {
  deviceId: string;
  userId: string;
  subscription: PushSubscriptionData;
  revision: string;
  schedule: ReminderRecord[];
  snapshotRevision: number;
  cachedRevision: number;
  payload?: string | null;
  refresh?: boolean;
};
export type PushSubscriptionData = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
type Config = { publicKey: string; privateKey: string; cronSecret: string };
export type ReminderDependencies = {
  now(): number;
  identity(token: string): Promise<{ id: string; sessionId: string } | null>;
  service<T>(action: string, data?: Data): Promise<T>;
  generateKeys(): { publicKey: string; privateKey: string };
  push(
    subscription: PushSubscriptionData,
    payload: string,
    config: Config,
  ): Promise<void>;
  digest(value: string): Promise<string>;
};
const ORIGIN = "https://morecreationapps.github.io";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const DUE_GRACE_MS = 90_000;
// Cron renews unchanged caches every 12 hours. Computing one elapsed day keeps
// closed-app delivery rolling without replanning 14 days in one Edge CPU budget.
export const SERVER_CACHE_HORIZON_DAYS = 1;
export const MAX_CONCURRENT_PUSHES = 4;
export function validPushSubscription(
  value: unknown,
): value is PushSubscriptionData {
  const item = value as PushSubscriptionData | null;
  if (
    !item ||
    typeof item.endpoint !== "string" ||
    item.endpoint.length > 4096 ||
    !item.keys ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(item.keys.p256dh) ||
    !/^[A-Za-z0-9_-]{20,30}$/.test(item.keys.auth)
  )
    return false;
  try {
    const url = new URL(item.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    // Fixed provider domains prevent endpoint-based SSRF to internal services.
    return (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "web.push.apple.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      url.hostname.endsWith(".push.services.mozilla.com") ||
      url.hostname.endsWith(".notify.windows.com")
    );
  } catch {
    return false;
  }
}
function equalSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export function createReminderHandler(deps: ReminderDependencies) {
  let configPromise: Promise<Config> | undefined;
  async function config() {
    configPromise ??= (async () =>
      (await deps.service<Config | null>("config")) ??
      (await deps.service<Config>("init", deps.generateKeys())))();
    try {
      return await configPromise;
    } catch (e) {
      configPromise = undefined;
      throw e;
    }
  }
  async function refresh(device: Device, revision?: string, client = false) {
    if (device.payload) {
      const state = parseBackup(device.payload);
      const schedule = desiredReminders(
        state,
        { now: () => deps.now() - DUE_GRACE_MS },
        { max: MAX_WEB_REMINDERS, horizonDays: SERVER_CACHE_HORIZON_DAYS },
      );
      const result = await deps.service<{ updated: boolean }>("cache", {
        userId: device.userId,
        deviceId: device.deviceId,
        snapshotRevision: device.snapshotRevision,
        reminders: schedule,
        ...(revision !== undefined ? { revision } : {}),
        client,
      });
      if (!result.updated) return null; // A simultaneous planner edit wins.
      device.schedule = schedule;
      device.cachedRevision = device.snapshotRevision;
      if (revision !== undefined) device.revision = revision;
    } else
      await deps.service("touch", {
        userId: device.userId,
        deviceId: device.deviceId,
      });
    return device;
  }
  async function send(device: Device, record: ReminderRecord, test = false) {
    if (!validPushSubscription(device.subscription)) return "invalid";
    const fingerprint = reminderFingerprint(record);
    const ledgerKey = await deps.digest(fingerprint + record.id);
    if (
      !test &&
      !(await deps.service<boolean>("claim", {
        deviceId: device.deviceId,
        userId: device.userId,
        snapshotRevision: device.snapshotRevision,
        fingerprint: ledgerKey,
      }))
    )
      return "duplicate-or-stale";
    try {
      await deps.push(
        device.subscription,
        JSON.stringify({
          ownerId: device.userId,
          deviceId: device.deviceId,
          revision: device.revision,
          reminder: record,
          fingerprint,
        }),
        await config(),
      );
      if (!test)
        await deps.service("outcome", {
          deviceId: device.deviceId,
          fingerprint: ledgerKey,
          outcome: "accepted",
        });
      return "accepted";
    } catch (error) {
      // Gone/expired subscriptions stop receiving. No provider details or keys
      // are logged, returned to the browser, or placed in the account planner.
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410)
        await deps.service("disable", {
          deviceId: device.deviceId,
          userId: device.userId,
        });
      if (!test)
        await deps.service("outcome", {
          deviceId: device.deviceId,
          fingerprint: ledgerKey,
          outcome: "failed",
        });
      if (test)
        throw new Error(
          "The push service could not accept the test notification. Re-enable alerts on this device and retry.",
        );
      return "failed";
    }
  }
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const allowedOrigin =
      !origin || origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    if (allowedOrigin && origin)
      headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] =
      "authorization,apikey,content-type,x-client-info";
    headers["Access-Control-Allow-Methods"] = "POST,OPTIONS";
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (!allowedOrigin)
      return response({ error: "Origin not permitted." }, 403);
    if (req.method === "OPTIONS") return response({ ok: true });
    if (req.method !== "POST")
      return response({ error: "POST required." }, 405);
    try {
      const text = await req.text();
      if (text.length > 16_384)
        return response({ error: "Request too large." }, 413);
      const body = JSON.parse(text) as Data;
      if (body.action === "dispatch") {
        const credential = req.headers.get("x-wakey-cron") ?? "";
        // Cron has its own server-only credential. User JWTs cannot dispatch.
        if (
          !credential ||
          !equalSecret(credential, (await config()).cronSecret)
        )
          return response({ error: "Unauthorised dispatcher." }, 401);
        if (
          body.deviceId !== undefined &&
          (typeof body.deviceId !== "string" || !UUID.test(body.deviceId))
        )
          return response({ error: "Invalid device identifier." }, 400);
        const devices = await deps.service<Device[]>(
          "devices",
          body.deviceId ? { deviceId: body.deviceId } : {},
        );
        let accepted = 0,
          failed = 0;
        const computed = new Map<
          string,
          { schedule: ReminderRecord[]; revision: number }
        >();
        for (let device of devices) {
          if (device.payload) {
            const key = `${device.userId}:${device.snapshotRevision}`;
            const cached = computed.get(key);
            if (cached) {
              const updated = await deps.service<{ updated: boolean }>(
                "cache",
                {
                  deviceId: device.deviceId,
                  userId: device.userId,
                  snapshotRevision: device.snapshotRevision,
                  reminders: cached.schedule,
                },
              );
              if (!updated.updated) continue;
              device.schedule = cached.schedule;
              device.cachedRevision = device.snapshotRevision;
            } else {
              const refreshed = await refresh(device);
              if (!refreshed) continue;
              device = refreshed;
              computed.set(key, {
                schedule: device.schedule,
                revision: device.snapshotRevision,
              });
            }
          } else
            await deps.service("touch", {
              userId: device.userId,
              deviceId: device.deviceId,
            });
          if (device.cachedRevision !== device.snapshotRevision) continue;
          let nextRecord = 0;
          await Promise.all(
            Array.from(
              {
                length: Math.min(MAX_CONCURRENT_PUSHES, device.schedule.length),
              },
              async () => {
                while (nextRecord < device.schedule.length) {
                  const record = device.schedule[nextRecord++];
                  // Check again when a worker reaches the item. A slow provider
                  // must not turn a queued, now-obsolete activity into an alert.
                  if (
                    record.at > deps.now() ||
                    record.at < deps.now() - DUE_GRACE_MS
                  )
                    continue;
                  const result = await send(device, record);
                  if (result === "accepted") accepted++;
                  if (result === "failed") failed++;
                }
              },
            ),
          );
        }
        return response({ checked: devices.length, accepted, failed });
      }
      const token = req.headers
        .get("authorization")
        ?.match(/^Bearer (.+)$/i)?.[1];
      const user = token ? await deps.identity(token) : null;
      if (!user || (body.ownerId && body.ownerId !== user.id))
        return response(
          { error: "A verified password session is required." },
          401,
        );
      if (body.action === "public-key")
        return response({ publicKey: (await config()).publicKey });
      const deviceId =
        typeof body.deviceId === "string" && UUID.test(body.deviceId)
          ? body.deviceId
          : null;
      if (!deviceId)
        return response({ error: "Invalid device identifier." }, 400);
      const owner = { deviceId, userId: user.id };
      if (body.action === "disable")
        return response(await deps.service("disable", owner));
      if (
        body.action === "subscribe" ||
        (body.action === "sync" && body.subscription !== undefined)
      ) {
        if (!validPushSubscription(body.subscription))
          return response({ error: "Unsupported push subscription." }, 400);
        await deps.service("subscribe", {
          ...owner,
          sessionId: user.sessionId,
          subscription: body.subscription,
        });
      }
      if (["sync", "subscribe"].includes(String(body.action))) {
        if (
          typeof body.revision !== "undefined" &&
          (typeof body.revision !== "string" ||
            !/^[a-f0-9]{64}$/.test(body.revision))
        )
          return response({ error: "Invalid schedule revision." }, 400);
        const device = await deps.service<Device | null>("device", owner);
        if (device)
          await refresh(device, body.revision as string | undefined, true);
        return response(
          (await deps.service("status", owner)) ?? {
            registered: false,
            scheduled: 0,
            through: null,
          },
        );
      }
      if (body.action === "status")
        return response(
          (await deps.service("status", owner)) ?? {
            registered: false,
            scheduled: 0,
            through: null,
          },
        );
      if (body.action === "test") {
        const device = await deps.service<Device | null>("device", owner);
        if (!device)
          return response(
            { error: "Enable notifications on this device first." },
            400,
          );
        await send(
          device,
          {
            id: `wakey:test:${crypto.randomUUID()}`,
            at: deps.now(),
            title: "Wakey-Wakey! test alert",
            body: "Web notifications are connected on this device. This is a notification, not a wake-up alarm.",
            kind: "test",
          },
          true,
        );
        return response({
          ...(await deps.service<Data>("status", owner)),
          message:
            "The push service accepted the test notification. Check this device's notification centre.",
        });
      }
      return response({ error: "Unsupported action." }, 400);
    } catch {
      return response(
        { error: "Notification service could not complete this request." },
        503,
      );
    }
  };
}
