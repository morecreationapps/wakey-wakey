import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  notificationScope,
  notificationScopeCurrent,
} from "./notificationScope";
import { AppState, Clock, systemClock } from "../model";
import {
  ALARM_LIMITATION,
  desiredReminders,
  NotificationStatus,
  permissionDescription,
  reconcileReminders,
  REMINDER_PREFIX,
  ReminderAdapter,
} from "./reminders";

const CHANNEL = "wakey-reminders";
const TEST_ID = `${REMINDER_PREFIX}test`;
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

const adapter: ReminderAdapter = {
  async list() {
    return (await Notifications.getAllScheduledNotificationsAsync())
      .filter((item) => item.identifier !== TEST_ID)
      .map((item) => ({
        id: item.identifier,
        fingerprint:
          typeof item.content.data?.wakeyFingerprint === "string"
            ? item.content.data.wakeyFingerprint
            : null,
        at:
          typeof item.content.data?.wakeyAt === "number"
            ? item.content.data.wakeyAt
            : null,
      }));
  },
  cancel: (id) => Notifications.cancelScheduledNotificationAsync(id),
  async schedule(record, fingerprint) {
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
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(record.at),
        channelId: CHANNEL,
      },
    });
  },
};
async function setup() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Planning reminders",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
      description:
        "Ordinary preparation, sleep-planning and appointment notifications",
    });
}
async function status(): Promise<NotificationStatus> {
  if (!nativeSupported()) return unsupported();
  const permission = permissionDescription(
    await Notifications.getPermissionsAsync(),
  );
  const pending = (await adapter.list()).filter((item) =>
    item.id.startsWith(REMINDER_PREFIX),
  );
  const times = pending
    .map((item) => item.at)
    .filter((at): at is number => at !== null);
  return {
    permission: permission.permission,
    supported: true,
    scheduled: pending.length,
    through: times.length ? Math.max(...times) : null,
    message: `${permission.detail} ${ALARM_LIMITATION}`,
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
    await reconcileReminders(
      adapter,
      permission.allowed ? desiredReminders(captured, clock) : [],
    );
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
    await Notifications.scheduleNotificationAsync({
      identifier: TEST_ID,
      content: {
        title: "Wakey-Wakey! test reminder",
        body: "This is an ordinary notification, not a phone alarm. Use a separate alarm for waking.",
        sound: "default",
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
  return serial(async () => {
    if (!nativeSupported()) return unsupported();
    await reconcileReminders(adapter, []);
    await Notifications.cancelScheduledNotificationAsync(TEST_ID);
    return status();
  });
}
