import { AppState, Clock, ReminderRecord, systemClock } from "../model";
import {
  notificationScope,
  notificationScopeCurrent,
} from "./notificationScope";
import {
  ALARM_LIMITATION,
  desiredReminders,
  MAX_WEB_REMINDERS,
  NotificationStatus,
} from "./reminders";
import { invokeReminderRemote } from "./reminderRemote";
import {
  createWebReminderController,
  DeliveryLedger,
  vapidKeyBytes,
  webAppRoot,
} from "./webReminders";
import { emitDueAlert } from "./reminderEvents";
export { subscribeDueAlerts } from "./reminderEvents";
export type { DueAlert } from "./reminderEvents";

interface RemoteStatus {
  registered?: boolean;
  scheduled: number;
  through: number | null;
  message?: string;
}
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = queue.then(operation);
  queue = next.catch(() => undefined);
  return next;
};
let activeScope = notificationScope();
let enabled = false;
let activeOwner: string | null = null;
let lastDesired: ReminderRecord[] = [];
let device: string | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let backgroundStatus: RemoteStatus | null = null;
let backgroundError = "";
let lastStateSource = "";
let lastRemoteSource = "";
let lastRemoteAt = 0;
const REGISTRATION_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
let testTimer: ReturnType<typeof setTimeout> | null = null;
const backgroundActive = () =>
  !!backgroundStatus && backgroundStatus.registered !== false;
const memoryLedgers = new Map<string, DeliveryLedger>();
const inBrowser = () =>
  typeof window !== "undefined" && typeof document !== "undefined";
const pushSupported = () =>
  inBrowser() &&
  window.isSecureContext &&
  "Notification" in window &&
  "PushManager" in window &&
  "serviceWorker" in navigator;
const deviceId = () => {
  if (device) return device;
  const key = "wakey:reminder-device:v1";
  try {
    device = window.localStorage.getItem(key);
  } catch {
    /* Private browsing can restrict storage. */
  }
  if (!device || !/^[a-zA-Z0-9-]{16,128}$/.test(device)) {
    device = crypto.randomUUID();
    try {
      window.localStorage.setItem(key, device);
    } catch {
      /* The running device still has a stable ID. */
    }
  }
  return device;
};
const controller = createWebReminderController({
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  isCurrent: (owner) =>
    enabled &&
    owner === activeScope.owner &&
    notificationScopeCurrent(activeScope),
  readLedger(owner) {
    if (inBrowser()) {
      try {
        const raw = window.localStorage.getItem(
          `wakey:reminder-delivered:${owner}`,
        );
        if (raw === null) return memoryLedgers.get(owner) ?? {};
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          return parsed as DeliveryLedger;
      } catch {
        /* Use the session ledger when persistent storage is unavailable. */
      }
    }
    return memoryLedgers.get(owner) ?? {};
  },
  writeLedger(owner, ledger) {
    memoryLedgers.set(owner, ledger);
    if (inBrowser()) {
      try {
        window.localStorage.setItem(
          `wakey:reminder-delivered:${owner}`,
          JSON.stringify(ledger),
        );
      } catch {
        /* Session deduplication remains active. */
      }
    }
  },
  emit: (alert) =>
    emitDueAlert(
      { ...alert, interaction: "received" },
      activeOwner ?? undefined,
    ),
});
function unsupported(): NotificationStatus {
  return {
    permission: "unsupported",
    supported: false,
    scheduled: 0,
    through: null,
    message: `This runtime has no browser notification interface. No alarm is active. ${ALARM_LIMITATION}`,
  };
}
function isIOSWithoutHomeScreen() {
  if (!inBrowser()) return false;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone;
  return ios && !standalone;
}
function status(): NotificationStatus {
  if (!inBrowser()) return unsupported();
  const pending = controller
    .pending()
    .filter((record) => record.kind !== "test");
  const permission = pushSupported()
    ? Notification.permission
    : isIOSWithoutHomeScreen()
      ? "home-screen-required"
      : "in-app-only";
  const detail = backgroundError
    ? `Background notification delivery needs attention: ${backgroundError}`
    : backgroundActive()
      ? "Background push reminders are registered for this device. They need an internet connection and may arrive up to a minute after the due time. Reopen this app at least once every 30 days to keep this device's registration active."
      : permission === "denied"
        ? "Browser notification permission is denied. Change the site's notification permission to receive alerts outside the app."
        : isIOSWithoutHomeScreen()
          ? "On iPhone or iPad, add this app to the Home Screen, open it there, then enable reminders to receive alerts outside the app."
          : pushSupported()
            ? "Use Enable alerts on this device to permit background browser notifications."
            : "This browser supports in-app due alerts while the app is open. Background push is unavailable here.";
  const scheduled = Math.max(pending.length, backgroundStatus?.scheduled ?? 0);
  const through =
    Math.max(
      ...pending.map((record) => record.at),
      backgroundStatus?.through ?? 0,
    ) || null;
  return {
    permission,
    supported: true,
    scheduled,
    through,
    message: `${enabled ? "In-app due alerts are enabled while this app is open." : "In-app due alerts are off."} ${detail} ${ALARM_LIMITATION}`,
  };
}
function rootUrl() {
  return webAppRoot(
    window.location.href,
    document.querySelector('link[rel="manifest"]')?.getAttribute("href") ??
      undefined,
  );
}
async function registration(): Promise<ServiceWorkerRegistration> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      const root = rootUrl();
      const result = await navigator.serviceWorker.register(
        new URL("service-worker.js", root).href,
        { scope: root.pathname, updateViaCache: "none" },
      );
      const worker = result.installing ?? result.waiting;
      if (worker && worker.state !== "activated") {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Notification worker activation timed out."));
          }, 10_000);
          const cleanup = () => {
            clearTimeout(timeout);
            worker.removeEventListener("statechange", changed);
          };
          const changed = () => {
            if (worker.state === "activated") {
              cleanup();
              resolve();
            } else if (worker.state === "redundant") {
              cleanup();
              reject(new Error("Notification worker could not start."));
            }
          };
          worker.addEventListener("statechange", changed);
          changed();
        });
      }
      return result;
    })().catch((error) => {
      registrationPromise = null;
      throw error;
    });
  }
  return registrationPromise;
}
async function routeOwner(ownerId: string | null, revision?: string) {
  if (!inBrowser() || !("serviceWorker" in navigator)) return;
  const registered = ownerId
    ? await registration()
    : await navigator.serviceWorker.getRegistration(rootUrl().href);
  const worker = registered?.active;
  if (!worker) return;
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Notification routing could not be saved."));
    }, 5_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ok) resolve();
      else reject(new Error("Notification routing could not be saved."));
    };
    worker.postMessage(
      {
        type: "wakey-reminder-owner",
        ownerId,
        deviceId: ownerId ? deviceId() : null,
        revision,
      },
      [channel.port2],
    );
  });
}
async function scheduleRevision(records: ReminderRecord[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(records)),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The reminder service could not be reached.";
if (inBrowser()) {
  window.addEventListener("focus", () => controller.refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") controller.refresh();
  });
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.addEventListener("message", (event) => {
      const payload = event.data;
      if (
        !payload ||
        payload.ownerId !== activeOwner ||
        payload.deviceId !== device ||
        !notificationScopeCurrent(activeScope)
      )
        return;
      const record = payload.reminder as ReminderRecord;
      if (
        !record ||
        typeof record.id !== "string" ||
        !record.id.startsWith("wakey:") ||
        typeof record.title !== "string" ||
        typeof record.body !== "string" ||
        !Number.isFinite(record.at)
      )
        return;
      if (payload.type === "wakey-reminder-due")
        controller.receive(payload.ownerId, record);
      if (payload.type === "wakey-reminder-open")
        emitDueAlert(
          {
            ...record,
            fingerprint: JSON.stringify([
              record.at,
              record.title,
              record.body,
              record.kind,
              record.entryId ?? null,
            ]),
            interaction: "opened",
          },
          payload.ownerId,
        );
    });
}
export function notificationStatus(): Promise<NotificationStatus> {
  const scope = notificationScope();
  return serial(async () => {
    if (
      inBrowser() &&
      device &&
      backgroundStatus &&
      notificationScopeCurrent(scope)
    ) {
      try {
        backgroundStatus = await invokeReminderRemote<RemoteStatus>({
          action: "status",
          ownerId: scope.owner,
          deviceId: device,
        });
        backgroundError = "";
      } catch (error) {
        backgroundError = errorMessage(error);
      }
    }
    return status();
  });
}
/** Only this explicit button action asks the browser for notification permission. */
export async function requestReminders(): Promise<NotificationStatus> {
  if (!inBrowser()) return unsupported();
  const scope = notificationScope();
  if (!notificationScopeCurrent(scope)) return status();
  // Request before any awaited operation so Safari retains the user's click activation.
  const permission = pushSupported()
    ? await Notification.requestPermission()
    : null;
  return serial(async () => {
    if (!notificationScopeCurrent(scope)) return status();
    activeScope = scope;
    activeOwner = scope.owner;
    enabled = true;
    backgroundError = "";
    backgroundStatus = null;
    controller.replace(scope.owner!, lastDesired);
    if (permission !== "granted") return status();
    try {
      const registered = await registration();
      if (!notificationScopeCurrent(scope)) return status();
      const { publicKey } = await invokeReminderRemote<{ publicKey: string }>({
        action: "public-key",
      });
      if (!notificationScopeCurrent(scope)) return status();
      const existing = await registered.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registered.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(publicKey),
        }));
      if (!notificationScopeCurrent(scope)) {
        if (!existing) await subscription.unsubscribe();
        return status();
      }
      await routeOwner(scope.owner);
      backgroundStatus = await invokeReminderRemote<RemoteStatus>({
        action: "subscribe",
        ownerId: scope.owner,
        deviceId: deviceId(),
        subscription: subscription.toJSON(),
      });
    } catch (error) {
      backgroundStatus = null;
      backgroundError = errorMessage(error);
    }
    return status();
  });
}
export function syncReminders(
  state: AppState,
  clock: Clock = systemClock,
  expectedOwner?: string,
): Promise<NotificationStatus> {
  const captured = JSON.parse(JSON.stringify(state)) as AppState;
  const scope = notificationScope();
  return serial(async () => {
    if (!inBrowser()) return unsupported();
    if (
      !notificationScopeCurrent(scope) ||
      (expectedOwner !== undefined && scope.owner !== expectedOwner)
    )
      return status();
    const source = JSON.stringify([scope.owner, scope.generation, captured]);
    const unchanged = source === lastStateSource;
    lastStateSource = source;
    activeScope = scope;
    activeOwner = scope.owner;
    enabled = captured.settings.remindersEnabled;
    lastDesired = enabled
      ? desiredReminders(captured, clock, { max: MAX_WEB_REMINDERS })
      : [];
    controller.replace(scope.owner!, lastDesired, { retainDue: unchanged });
    if (!enabled) {
      if (unchanged) return status();
      try {
        await routeOwner(null);
        if (device)
          await invokeReminderRemote({
            action: "disable",
            ownerId: scope.owner,
            deviceId: device,
          });
        backgroundError = "";
      } catch (error) {
        backgroundError = errorMessage(error);
      }
      backgroundStatus = null;
      lastRemoteSource = "";
      lastRemoteAt = 0;
      return status();
    }
    if (!pushSupported() || Notification.permission !== "granted") {
      if (backgroundActive()) {
        await routeOwner(null);
        if (device)
          await invokeReminderRemote({
            action: "disable",
            ownerId: scope.owner,
            deviceId: device,
          });
      }
      backgroundStatus = null;
      return status();
    }
    // The server renews the horizon from the authoritative saved account. Send
    // an unchanged plan at most once/day to keep an actively used registration
    // alive without rewriting it on every minute tick.
    const heartbeatAge = Date.now() - lastRemoteAt;
    if (
      source === lastRemoteSource &&
      backgroundActive() &&
      !backgroundError &&
      heartbeatAge >= 0 &&
      heartbeatAge < REGISTRATION_HEARTBEAT_MS
    )
      return status();
    try {
      const registered = await registration();
      const subscription = await registered.pushManager.getSubscription();
      if (!notificationScopeCurrent(scope)) return status();
      if (!subscription) {
        backgroundStatus = null;
        return status();
      }
      const revision = await scheduleRevision(lastDesired);
      if (!notificationScopeCurrent(scope)) return status();
      await routeOwner(scope.owner, revision);
      backgroundStatus = await invokeReminderRemote<RemoteStatus>({
        action: "sync",
        ownerId: scope.owner,
        deviceId: deviceId(),
        subscription: subscription.toJSON(),
        revision,
      });
      backgroundError = "";
      lastRemoteSource = source;
      lastRemoteAt = Date.now();
    } catch (error) {
      backgroundStatus = null;
      backgroundError = errorMessage(error);
    }
    return status();
  });
}
export function testNotification(): Promise<NotificationStatus> {
  const scope = notificationScope();
  return serial(async () => {
    if (!inBrowser()) return unsupported();
    if (!enabled || !notificationScopeCurrent(scope))
      return {
        ...status(),
        message: "Use Enable alerts on this device before requesting a test.",
      };
    if (testTimer) clearTimeout(testTimer);
    testTimer = null;
    let fallback = false;
    // The worker forwards the same push into the in-app alert hub. Scheduling
    // another foreground test as well would create two different test alerts.
    if (backgroundActive()) {
      try {
        const result = await invokeReminderRemote<RemoteStatus>({
          action: "test",
          ownerId: scope.owner,
          deviceId: deviceId(),
        });
        if (!notificationScopeCurrent(scope)) return status();
        backgroundError = "";
        return {
          ...status(),
          message: `${result.message ?? "The push service accepted the test notification. Check this device's notification centre."} ${status().message}`,
        };
      } catch (error) {
        if (!notificationScopeCurrent(scope)) return status();
        backgroundError = errorMessage(error);
        fallback = true;
      }
    }
    const test: ReminderRecord = {
      id: "wakey:test",
      at: Date.now() + 5_000,
      title: "Wakey-Wakey! test reminder",
      body: "This is an ordinary notification. Use a separate phone alarm for waking.",
      kind: "test",
    };
    testTimer = setTimeout(() => {
      testTimer = null;
      if (enabled && notificationScopeCurrent(scope))
        controller.receive(scope.owner!, test);
    }, 5_000);
    return {
      ...status(),
      message: `${fallback ? "The push test request failed; an in-app fallback test is requested for five seconds from now." : "In-app test requested for five seconds from now. No background push test is registered."} ${status().message}`,
    };
  });
}
export function disableReminders(): Promise<NotificationStatus> {
  const owner = activeOwner;
  enabled = false;
  controller.clear();
  lastDesired = [];
  backgroundStatus = null;
  activeOwner = null;
  lastStateSource = "";
  lastRemoteSource = "";
  lastRemoteAt = 0;
  if (testTimer) clearTimeout(testTimer);
  testTimer = null;
  return serial(async () => {
    if (!inBrowser()) return unsupported();
    await routeOwner(null);
    if (owner && device) {
      try {
        await invokeReminderRemote({
          action: "disable",
          ownerId: owner,
          deviceId: deviceId(),
        });
        backgroundError = "";
      } catch (error) {
        backgroundError = errorMessage(error);
        throw new Error(
          `In-app alerts are off; background cancellation needs attention: ${backgroundError}`,
        );
      }
    }
    return status();
  });
}
