import { AppState, Clock } from "../model";
import { ALARM_LIMITATION, NotificationStatus } from "./reminders";

const status = (): NotificationStatus => ({
  permission: "unsupported",
  supported: false,
  scheduled: 0,
  through: null,
  message: `Browser reminders are unavailable in this version. No alarm is active. Use the iOS/Android app for opt-in local reminders. ${ALARM_LIMITATION}`,
});
export async function notificationStatus(): Promise<NotificationStatus> {
  return status();
}
export async function requestReminders(): Promise<NotificationStatus> {
  return status();
}
export async function syncReminders(
  _state: AppState,
  _clock?: Clock,
  _expectedOwner?: string,
): Promise<NotificationStatus> {
  return status();
}
export async function testNotification(): Promise<NotificationStatus> {
  return status();
}
export async function disableReminders(): Promise<NotificationStatus> {
  return status();
}
