import React, { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import {
  ScreenProps,
  Card,
  Row,
  Button,
  Body,
  Heading,
  Choices,
  Toggle,
  Pill,
  Notice,
  ui,
} from "./components";
import { SettingsFields } from "./Setup";
import {
  notificationStatus,
  requestReminders,
  syncReminders,
  testNotification,
  disableReminders,
} from "../platform/notifications";
import {
  NotificationStatus,
  upgradeReminderCoverage,
} from "../platform/reminders";
import { exportBackup, parseBackup } from "../data/backup";
import { pickTextFile, exportTextFile } from "../platform/files";

import { initialState } from "../data/defaults";
import { AppState, systemClock } from "../model";
import { displayDate, displayTime, localAt } from "../engine/time";
import type { AccountConflictRecovery } from "../auth/accountStore";
export function SettingsScreen({
  state,
  change,
  notify,
  saveAccount,
  resetAccount,
  accountEmail,
  accountId,
  logout,
  recovery,
  exportRecovery,
}: ScreenProps & {
  saveAccount: (state: AppState) => Promise<void>;
  resetAccount: () => Promise<void>;
  accountEmail: string;
  accountId: string;
  logout: () => Promise<void>;
  recovery?: AccountConflictRecovery | null;
  exportRecovery?: (source: "device" | "account") => void;
}) {
  const [section, setSection] = useState("Work"),
    [status, setStatus] = useState<NotificationStatus | null>(null),
    [restore, setRestore] = useState<AppState | null>(null),
    [deleteConfirm, setDeleteConfirm] = useState(false);
  const s = state.settings;
  const reminderSettings = {
    ...upgradeReminderCoverage({ ...s, remindersEnabled: true }),
    remindersEnabled: s.remindersEnabled,
  };
  const refresh = () =>
    notificationStatus()
      .then(setStatus)
      .catch((e) => notify(e.message));
  useEffect(() => {
    refresh();
  }, []);
  const run = async (fn: () => Promise<NotificationStatus>) => {
    try {
      setStatus(await fn());
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <View style={ui.stack}>
      <Heading>Your settings.</Heading>
      <Card>
        <Heading small>Your account</Heading>
        <Body>{accountEmail}</Body>
        <Button title="Log out" icon="log-out" onPress={() => void logout()} />
      </Card>
      <Body muted>
        Change your routine as life changes. Saved duties keep their recorded
        local work time and timezone.
      </Body>
      <Card>
        <Choices
          values={["Work", "Travel", "Sleep", "Daily life"]}
          value={section}
          onChange={setSection}
        />
        <SettingsFields
          state={state}
          change={change}
          section={
            ["Work", "Travel", "Sleep", "Daily life"].indexOf(section) + 1
          }
        />
        <Button
          title="Review setup again"
          secondary
          onPress={() =>
            change((a) => ({
              ...a,
              settings: {
                ...a.settings,
                onboardingComplete: false,
                onboardingStep: 1,
              },
            }))
          }
        />
      </Card>
      <Card>
        <Heading small>Reminders & permissions</Heading>
        <Row>
          <Pill text={status?.permission ?? "Checking permission"} />
          <Pill text={s.remindersEnabled ? "Alerts enabled" : "Alerts off"} />
          <Pill text={`${status?.scheduled ?? 0} scheduled`} />
        </Row>
        <Body muted>{status?.message}</Body>
        <Body>
          Wake-up reminders are ordinary notifications. They may be blocked or
          delayed by silent mode, Focus / Do Not Disturb, battery restrictions
          or permissions. Use a separate phone alarm.
        </Body>
        <Body muted>
          Alerts use the dates and times in Shift Transition and Shift Plan,
          including individual tasks. Editing, completing or deleting an item
          updates its alerts after the change is saved.
        </Body>
        <Body muted>
          {Platform.OS === "web"
            ? "In-app alerts appear while this page is open. To receive system notifications with the app closed, enable notifications on this browser or home-screen app. On iPhone/iPad, add the app to your Home Screen first (iOS/iPadOS 16.4 or later), open it there and enable alerts. The server checks due alerts every minute; network and device settings can delay delivery. Reopen this app at least once every 30 days to keep background alerts active on this device."
            : "In-app alerts appear while this app is open. With notification permission, this device schedules up to 60 system alerts for the next 14 days. Open the app to refresh that rolling schedule. Alerts already scheduled can arrive while the app is closed. Edits made on another device take effect here when this app next synchronises."}
        </Body>
        {!!status?.through && (
          <Body>
            Latest scheduled reminder:{" "}
            {displayDate(
              localAt(status.through, s.timezone).slice(0, 10),
              s.dateFormat,
            )}{" "}
            {displayTime(status.through, s.timezone, s.clockFormat)}
          </Body>
        )}
        <Button
          title="Enable alerts on this device"
          icon="bell"
          onPress={async () => {
            try {
              const p = await requestReminders();
              setStatus(p);
              if (p.supported) {
                const next = {
                  ...state,
                  settings: {
                    ...upgradeReminderCoverage({
                      ...s,
                      remindersEnabled: true,
                    }),
                    reminderCoverageVersion: 1 as const,
                  },
                };
                change(() => next);
                notify(
                  ["granted", "provisional", "ephemeral"].includes(p.permission)
                    ? "Alerts enabled. The schedule refreshes after your settings are saved."
                    : "In-app alerts enabled while the app is open. System notifications need permission on this device. The schedule refreshes after your settings are saved.",
                );
              } else notify(p.message);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
        <Body muted>Choose reminder types</Body>
        {[
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
        ].map((kind) => (
          <Toggle
            key={kind}
            label={
              kind === "activity"
                ? "Other Shift Plan activities (arrival, work, finish and sleep start)"
                : kind === "task"
                  ? "Individual preparation tasks"
                  : kind === "transition"
                    ? "Upcoming shift change review"
                    : kind === "caffeine"
                      ? "Consider avoiding caffeine"
                      : kind === "appointment"
                        ? "Appointments and appointment travel"
                        : kind === "wake"
                          ? "Wake-up reminder"
                          : kind === "windDown"
                            ? "Begin wind-down"
                            : kind[0].toUpperCase() + kind.slice(1)
            }
            value={reminderSettings.reminderKinds.includes(kind)}
            onChange={(v) =>
              change((a) => ({
                ...a,
                settings: {
                  ...upgradeReminderCoverage({
                    ...a.settings,
                    remindersEnabled: true,
                  }),
                  remindersEnabled: a.settings.remindersEnabled,
                  reminderCoverageVersion: 1,
                  ...(kind === "caffeine" ? { caffeine: v } : {}),
                  reminderKinds: v
                    ? [
                        ...new Set([
                          ...upgradeReminderCoverage({
                            ...a.settings,
                            remindersEnabled: true,
                          }).reminderKinds,
                          kind,
                        ]),
                      ]
                    : upgradeReminderCoverage({
                        ...a.settings,
                        remindersEnabled: true,
                      }).reminderKinds.filter((k) => k !== kind),
                },
              }))
            }
          />
        ))}
        <Row>
          <Button
            title="Test notification"
            secondary
            onPress={() => run(testNotification)}
          />
          <Button
            title="Refresh status & schedule"
            secondary
            onPress={() =>
              run(async () => {
                await saveAccount(state);
                return syncReminders(state, systemClock, accountId);
              })
            }
          />
          <Button
            title="Turn reminders off"
            secondary
            onPress={async () => {
              change((a) => ({
                ...a,
                settings: { ...a.settings, remindersEnabled: false },
              }));
              await run(disableReminders);
            }}
          />
        </Row>
      </Card>
      <Card>
        <Heading small>Privacy, backup & restore</Heading>
        {!!recovery && !!exportRecovery && (
          <Card>
            <Heading small>Preserved versions from account recovery</Heading>
            <Body>
              Both versions were kept on this device before you opened the saved
              account planner. Download them to review or keep them elsewhere.
              Downloading does not replace your current planner.
            </Body>
            <Body>
              Device version: {recovery.device.summary.rotaEntries} rota
              entries, {recovery.device.summary.tasks} tasks,{" "}
              {recovery.device.summary.sleepLogs} sleep logs.
            </Body>
            <Body>
              Account version: {recovery.account.summary.rotaEntries} rota
              entries, {recovery.account.summary.tasks} tasks,{" "}
              {recovery.account.summary.sleepLogs} sleep logs.
            </Body>
            <Row>
              <Button
                title="Download preserved device version"
                secondary
                icon="download"
                onPress={() => exportRecovery("device")}
              />
              <Button
                title="Download preserved account version"
                secondary
                icon="download"
                onPress={() => exportRecovery("account")}
              />
            </Row>
          </Card>
        )}
        <Body>
          Your rota, settings, tasks and diary belong to your verified account
          and synchronise with its protected backend. This device keeps an
          account-specific copy for saved changes. Native planner storage uses
          ordinary SQLite; encryption of planner records has not been
          implemented. Native session credentials use secure storage. Browser
          copies use this browser’s local storage.
        </Body>
        <Body muted>
          A backup includes private notes and sleep logs. Keep the exported file
          somewhere you trust. CSV and calendar exports omit notes by default.
        </Body>
        <Row>
          <Button
            title="Export full backup"
            secondary
            icon="download"
            onPress={() =>
              exportTextFile(
                "wakey-backup.json",
                exportBackup(state),
                "application/json",
              ).catch((e) => notify(e.message))
            }
          />
          <Button
            title="Choose backup to restore"
            secondary
            icon="upload"
            onPress={async () => {
              try {
                const f = await pickTextFile();
                if (f) setRestore(parseBackup(f.text));
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          />
        </Row>
        {restore && (
          <Notice>
            Valid backup preview: {restore.entries.length} rota entries,{" "}
            {restore.tasks.length} tasks, {restore.sleepLogs.length} sleep
            check-ins. Confirming replaces this account’s planner and
            synchronised data. Reminders are disabled until you opt in again.
          </Notice>
        )}
        {restore && (
          <Row>
            <Button
              title="Confirm replacement from backup"
              onPress={() => {
                change(() => ({
                  ...restore,
                  settings: { ...restore.settings, remindersEnabled: false },
                }));
                setRestore(null);
                notify(
                  "Backup opened in your planner; account saving is in progress. Reminders remain off. Undo is available.",
                );
              }}
            />
            <Button
              title="Cancel restore"
              secondary
              onPress={() => setRestore(null)}
            />
          </Row>
        )}
        <Button
          title={
            deleteConfirm
              ? "Confirm reset my account planner"
              : "Reset my account planner"
          }
          danger
          icon="trash-2"
          onPress={async () => {
            if (!deleteConfirm) {
              setDeleteConfirm(true);
              return;
            }
            try {
              await disableReminders();
              await resetAccount();
              change(() => initialState());
              setDeleteConfirm(false);
              notify(
                "Your account planner was reset. A fresh setup is open; your login is retained.",
              );
            } catch (e) {
              notify(
                `Deletion could not be completed: ${(e as Error).message}`,
              );
            }
          }}
        />
        {deleteConfirm && (
          <Notice error>
            This resets your account’s rota, tasks, settings and diary,
            including the synchronised copy. Export a backup first if you need
            to keep them.
          </Notice>
        )}
      </Card>
    </View>
  );
}
