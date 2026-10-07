import React, { useEffect, useState } from "react";
import { View } from "react-native";
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
import { NotificationStatus } from "../platform/reminders";
import { exportBackup, parseBackup } from "../data/backup";
import { pickTextFile, exportTextFile } from "../platform/files";
import { deleteState, saveState } from "../platform/store";
import { initialState } from "../data/defaults";
import { AppState, systemClock } from "../model";
import { displayDate, displayTime, localAt } from "../engine/time";
export function SettingsScreen({ state, change, notify }: ScreenProps) {
  const [section, setSection] = useState("Work"),
    [status, setStatus] = useState<NotificationStatus | null>(null),
    [restore, setRestore] = useState<AppState | null>(null),
    [deleteConfirm, setDeleteConfirm] = useState(false);
  const s = state.settings;
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
          <Pill text={`${status?.scheduled ?? 0} scheduled`} />
        </Row>
        <Body muted>{status?.message}</Body>
        <Body>
          Wake-up reminders are ordinary notifications. They may be blocked or
          delayed by silent mode, Focus / Do Not Disturb, battery restrictions
          or permissions. Use a separate phone alarm.
        </Body>
        <Body muted>
          Rolling horizon: up to 14 days, at most 60 notifications. Open the app
          to refresh. Background renewal is not guaranteed.
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
          title="Enable opt-in reminders"
          icon="bell"
          onPress={async () => {
            try {
              const p = await requestReminders();
              setStatus(p);
              if (
                p.supported &&
                ["granted", "provisional", "ephemeral"].includes(p.permission)
              ) {
                const next = {
                  ...state,
                  settings: { ...s, remindersEnabled: true },
                };
                change(() => next);
                notify(
                  "Reminders enabled. The schedule refreshes after your setup is saved.",
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
        ].map((kind) => (
          <Toggle
            key={kind}
            label={
              kind === "wake"
                ? "Wake-up reminder"
                : kind === "windDown"
                  ? "Begin wind-down"
                  : kind[0].toUpperCase() + kind.slice(1)
            }
            value={s.reminderKinds.includes(kind)}
            onChange={(v) =>
              change((a) => ({
                ...a,
                settings: {
                  ...a.settings,
                  ...(kind === "caffeine" ? { caffeine: v } : {}),
                  reminderKinds: v
                    ? [...new Set([...a.settings.reminderKinds, kind])]
                    : a.settings.reminderKinds.filter((k) => k !== kind),
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
                await saveState(state);
                return syncReminders(state, systemClock);
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
        <Body>
          Your rota, settings, tasks and diary stay local. No mandatory account,
          analytics or AI upload. Native storage uses ordinary SQLite;
          encryption has not been implemented or verified. Browser preview uses
          this browser’s local storage.
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
            check-ins. Confirming replaces the currently saved app data.
            Reminders are disabled until you opt in again.
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
                  "Backup restored. Reminders remain off. Undo is available.",
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
              ? "Confirm delete all my local data"
              : "Delete all my local data"
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
              await deleteState();
              change(() => initialState());
              setDeleteConfirm(false);
              notify("Saved local app data cleared. A fresh setup is open.");
            } catch (e) {
              notify(
                `Deletion could not be completed: ${(e as Error).message}`,
              );
            }
          }}
        />
        {deleteConfirm && (
          <Notice error>
            This clears rota, tasks, settings and diary on this device. Export a
            backup first if you need to keep them.
          </Notice>
        )}
      </Card>
    </View>
  );
}
