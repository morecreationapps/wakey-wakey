import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  notificationScope,
  notificationScopeCurrent,
} from "./notificationScope";
import { AppState, Clock, ReminderRecord, systemClock } from "../model";
import {
  DueAlert,
  DueAlertListener,
  emitDueAlert,
  subscribeDueAlerts as subscribeAlertEvents,
} from "./reminderEvents";
import {
  ALARM_LIMITATION,
  desiredReminders,
  NotificationStatus,
  permissionDescription,
  reconcileReminders,
  reminderFingerprint,
  REMINDER_PREFIX,
  ReminderAdapter,
} from "./reminders";
import {
  createWebReminderController,
  DeliveryLedger,
  DUE_ALERT_GRACE_MS,
} from "./webReminders";

export type { DueAlert, DueAlertListener } from "./reminderEvents";

const CHANNEL = "wakey-reminders";
const TEST_ID = `${REMINDER_PREFIX}test`;
const dueListeners = new Set<DueAlertListener>();
const delivered = new Set<string>();
let receiveSubscription: { remove(): void } | null = null;
let responseSubscription: { remove(): void } | null = null;
let handlerInstalled = false;
let channelSetup: Promise<void> | null = null;
let activeClock: Clock = systemClock;
let lastPlan: {
  owner: string;
  signature: string;
  records: ReminderRecord[];
} | null = null;
const receiptLedgers = new Map<string, DeliveryLedger>();
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = queue.then(operation);
  queue = next.catch(() => undefined);
  return next;
};
const nativeSupported = () =>
  Platform.OS === "ios" || Platform.OS === "android";
const unsupported = (): NotificationStatus => ({
  permission: "unsupported",
  supported: false,
  scheduled: 0,
  through: null,
  message: `Local reminders are available in the iOS/Android app. ${ALARM_LIMITATION}`,
});

/** Reject old account deliveries, including an OS callback racing logout. */
function alertFromNotification(
  notification: Notifications.Notification,
  interaction: DueAlert["interaction"],
): DueAlert | null {
  const { identifier, content } = notification.request;
  const data = content.data;
  const owner = notificationScope().owner;
  if (
    !owner ||
    data?.wakeyOwnerId !== owner ||
    !identifier.startsWith(REMINDER_PREFIX) ||
    typeof data.wakeyAt !== "number" ||
    !Number.isFinite(data.wakeyAt) ||
    typeof data.wakeyFingerprint !== "string" ||
    typeof data.wakeyKind !== "string" ||
    typeof content.title !== "string" ||
    typeof content.body !== "string"
  )
    return null;
  const record: ReminderRecord = {
    id: identifier,
    at: data.wakeyAt,
    title: content.title,
    body: content.body,
    kind: data.wakeyKind,
    ...(typeof data.wakeyEntryId === "string"
      ? { entryId: data.wakeyEntryId }
      : {}),
  };
  if (reminderFingerprint(record) !== data.wakeyFingerprint) return null;
  return { ...record, fingerprint: data.wakeyFingerprint, interaction };
}

function emitNotification(
  notification: Notifications.Notification,
  interaction: DueAlert["interaction"],
) {
  const alert = alertFromNotification(notification, interaction);
  if (!alert) return;
  emitNativeAlert(alert);
  if (interaction === "opened") Notifications.clearLastNotificationResponse();
}

function emitNativeAlert(alert: DueAlert) {
  const interaction = alert.interaction ?? "received";
  const key = `${notificationScope().owner}:${alert.id}:${alert.fingerprint}:${interaction}`;
  if (delivered.has(key)) return;
  delivered.add(key);
  // Keep only a bounded receipt history; native scheduling itself owns delivery.
  if (delivered.size > 256) delivered.delete(delivered.values().next().value!);
  emitDueAlert(alert, notificationScope().owner!);
}

// Foreground banners share the web's due-time/deduplication rules. Native OS
// scheduling remains responsible for alerts while this JavaScript is suspended.
const foreground = createWebReminderController({
  now: () => activeClock.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  isCurrent: (owner) => notificationScope().owner === owner,
  readLedger: (owner) => receiptLedgers.get(owner) ?? {},
  writeLedger: (owner, ledger) => {
    receiptLedgers.set(owner, ledger);
  },
  emit: (alert) => emitNativeAlert({ ...alert, interaction: "received" }),
});

function installHandler() {
  if (!nativeSupported() || handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const allowed = !!alertFromNotification(notification, "received");
      return {
        shouldShowBanner: allowed,
        shouldShowList: allowed,
        shouldPlaySound: allowed,
        shouldSetBadge: false,
      };
    },
  });
}

/** Registers delivery/tap listeners at app launch without requesting permission. */
export function subscribeDueAlerts(listener: DueAlertListener): () => void {
  if (!nativeSupported()) return () => undefined;
  installHandler();
  dueListeners.add(listener);
  const unsubscribeEvents = subscribeAlertEvents(listener);
  if (!receiveSubscription)
    receiveSubscription = Notifications.addNotificationReceivedListener(
      (notification) => emitNotification(notification, "received"),
    );
  if (!responseSubscription)
    responseSubscription =
      Notifications.addNotificationResponseReceivedListener(
        ({ notification }) => emitNotification(notification, "opened"),
      );
  // The initial response remains available while authentication restores. The
  // same read after scheduling lets the newly restored owner handle a cold tap.
  if (lastPlan?.owner === notificationScope().owner)
    foreground.replace(lastPlan.owner, lastPlan.records, { retainDue: true });
  receiveLastResponse();
  return () => {
    dueListeners.delete(listener);
    unsubscribeEvents();
    if (!dueListeners.size) {
      receiveSubscription?.remove();
      responseSubscription?.remove();
      receiveSubscription = responseSubscription = null;
      foreground.clear();
    }
  };
}

function receiveLastResponse() {
  if (!dueListeners.size || !nativeSupported()) return;
  const response = Notifications.getLastNotificationResponse();
  if (response) emitNotification(response.notification, "opened");
}

/** An adapter is fenced at every async mutation, not just before reconciliation. */
function adapterForScope(
  scope: ReturnType<typeof notificationScope>,
  clock: Clock,
): ReminderAdapter {
  return {
    async list() {
      return (await Notifications.getAllScheduledNotificationsAsync())
        .filter((item) => item.identifier !== TEST_ID)
        .map((item) => ({
          id: item.identifier,
          fingerprint:
            item.content.data?.wakeyOwnerId === scope.owner &&
            typeof item.content.data?.wakeyFingerprint === "string"
              ? item.content.data.wakeyFingerprint
              : null,
          at:
            typeof item.content.data?.wakeyAt === "number"
              ? item.content.data.wakeyAt
              : null,
        }));
    },
    async cancel(id) {
      if (notificationScopeCurrent(scope))
        await Notifications.cancelScheduledNotificationAsync(id);
    },
    async schedule(record, fingerprint) {
      if (!notificationScopeCurrent(scope) || record.at <= clock.now()) return;
      await Notifications.scheduleNotificationAsync({
        identifier: record.id,
        content: {
          title: record.title,
          body: record.body,
          sound: "default",
          data: {
            wakeyAt: record.at,
            wakeyFingerprint: fingerprint,
            wakeyKind: record.kind,
            wakeyOwnerId: scope.owner,
            ...(record.entryId ? { wakeyEntryId: record.entryId } : {}),
          },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(record.at),
          channelId: CHANNEL,
        },
      });
      // The OS can finish accepting a request after logout. The serial queue
      // prevents the next owner's scheduler from running before this cleanup.
      if (!notificationScopeCurrent(scope))
        await Notifications.cancelScheduledNotificationAsync(record.id);
    },
  };
}
async function setup() {
  installHandler();
  if (Platform.OS === "android" && !channelSetup)
    channelSetup = Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Planning reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
      description:
        "Ordinary preparation, sleep-planning and appointment notifications",
    })
      .then(() => undefined)
      .catch((error) => {
        channelSetup = null;
        throw error;
      });
  if (channelSetup) await channelSetup;
}
async function status(): Promise<NotificationStatus> {
  if (!nativeSupported()) return unsupported();
  const permission = permissionDescription(
    await Notifications.getPermissionsAsync(),
  );
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const owner = notificationScope().owner;
  const pending = scheduled.filter(
    (item) =>
      !!owner &&
      item.identifier !== TEST_ID &&
      item.identifier.startsWith(REMINDER_PREFIX) &&
      item.content.data?.wakeyOwnerId === owner,
  );
  const times = pending
    .map((item) => item.content.data?.wakeyAt)
    .filter(
      (at): at is number => typeof at === "number" && Number.isFinite(at),
    );
  return {
    permission: permission.permission,
    supported: true,
    scheduled: pending.length,
    through: times.length ? Math.max(...times) : null,
    message: `${permission.detail} In-app alerts appear while this app is open and reminders are enabled. ${permission.allowed ? "" : "Background alerts need notification permission in your device settings. "}${Platform.OS === "android" ? "Android may delay ordinary reminders under its battery and alarm restrictions. " : ""}${ALARM_LIMITATION} Reopen the app to refresh the next 14 days; at most 60 reminders are queued on this device.`,
  };
}
export function notificationStatus(): Promise<NotificationStatus> {
  return serial(status);
}

/** Only the explicit opt-in action calls the OS permission prompt. */
export function requestReminders(): Promise<NotificationStatus> {
  return serial(async () => {
    if (!nativeSupported()) return unsupported();
    await setup();
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return status();
  });
}
export function syncReminders(
  state: AppState,
  clock: Clock = systemClock,
  expectedOwner?: string,
): Promise<NotificationStatus> {
  // Snapshot the revision submitted by the caller before waiting behind another reconciliation.
  const captured = JSON.parse(JSON.stringify(state)) as AppState;
  const scope = notificationScope();
  return serial(async () => {
    if (!nativeSupported()) return unsupported();
    if (
      !notificationScopeCurrent(scope) ||
      (expectedOwner !== undefined && scope.owner !== expectedOwner)
    )
      return status();
    await setup();
    const permission = permissionDescription(
      await Notifications.getPermissionsAsync(),
    );
    if (
      !notificationScopeCurrent(scope) ||
      (expectedOwner !== undefined && scope.owner !== expectedOwner)
    )
      return status();
    activeClock = clock;
    const signature = JSON.stringify(captured);
    const unchanged =
      lastPlan?.owner === scope.owner && lastPlan.signature === signature;
    const desired = desiredReminders(captured, clock);
    const now = clock.now();
    const justDue = unchanged
      ? lastPlan!.records.filter(
          (record) => record.at <= now && now - record.at <= DUE_ALERT_GRACE_MS,
        )
      : [];
    const intended = [
      ...new Map(
        [...justDue, ...desired].map((record) => [record.id, record]),
      ).values(),
    ];
    // A minute refresh must not cancel a due request merely because its timer
    // callback or OS delivery has not run yet. A changed saved plan drops it.
    if (dueListeners.size)
      foreground.replace(scope.owner!, desired, { retainDue: unchanged });
    lastPlan = { owner: scope.owner!, signature, records: intended };
    await reconcileReminders(
      adapterForScope(scope, clock),
      permission.allowed ? intended : [],
    );
    receiveLastResponse();
    return status();
  });
}
export function testNotification(): Promise<NotificationStatus> {
  const scope = notificationScope();
  return serial(async () => {
    if (!nativeSupported()) return unsupported();
    if (!notificationScopeCurrent(scope)) return status();
    const permission = permissionDescription(
      await Notifications.getPermissionsAsync(),
    );
    if (!permission.allowed || !notificationScopeCurrent(scope))
      return status();
    await setup();
    if (!notificationScopeCurrent(scope)) return status();
    await Notifications.cancelScheduledNotificationAsync(TEST_ID);
    if (!notificationScopeCurrent(scope)) return status();
    const record: ReminderRecord = {
      id: TEST_ID,
      at: Date.now() + 5000,
      title: "Wakey-Wakey! test reminder",
      body: "This is an ordinary notification, not a phone alarm. Use a separate alarm for waking.",
      kind: "test",
    };
    await Notifications.scheduleNotificationAsync({
      identifier: TEST_ID,
      content: {
        title: record.title,
        body: record.body,
        sound: "default",
        data: {
          wakeyOwnerId: scope.owner,
          wakeyAt: record.at,
          wakeyKind: record.kind,
          wakeyFingerprint: reminderFingerprint(record),
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5,
        repeats: false,
        channelId: CHANNEL,
      },
    });
    // The OS scheduling promise can finish after logout. Cancel this stale
    // request before the next account's queued notification operation begins.
    if (!notificationScopeCurrent(scope)) {
      await Notifications.cancelScheduledNotificationAsync(TEST_ID);
      return status();
    }
    return {
      ...(await status()),
      message: `Test requested for five seconds from now. ${permission.detail} ${ALARM_LIMITATION}`,
    };
  });
}
export function disableReminders(): Promise<NotificationStatus> {
  const scope = notificationScope();
  // Stop in-app timers immediately, before any asynchronous OS cancellation.
  foreground.clear();
  lastPlan = null;
  return serial(async () => {
    if (!nativeSupported()) return unsupported();
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    for (const item of pending) {
      if (!item.identifier.startsWith(REMINDER_PREFIX)) continue;
      const itemOwner = item.content.data?.wakeyOwnerId;
      const activeOwner = notificationScope().owner;
      // A late cleanup for an old session must preserve the next account.
      if (
        activeOwner &&
        activeOwner !== scope.owner &&
        itemOwner === activeOwner
      )
        continue;
      await Notifications.cancelScheduledNotificationAsync(item.identifier);
    }
    // Cancel removes queued deliveries; dismiss also clears already displayed
    // activities from the previous session's notification centre.
    if (typeof Notifications.getPresentedNotificationsAsync === "function") {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const item of presented) {
        if (!item.request.identifier.startsWith(REMINDER_PREFIX)) continue;
        const activeOwner = notificationScope().owner;
        if (
          activeOwner &&
          activeOwner !== scope.owner &&
          item.request.content.data?.wakeyOwnerId === activeOwner
        )
          continue;
        await Notifications.dismissNotificationAsync(item.request.identifier);
      }
    }
    delivered.clear();
    return status();
  });
}

// Installing the handler does not prompt for permission and is synchronous.
installHandler();
