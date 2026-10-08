import React, { useState } from "react";
import { View } from "react-native";
import { Task, uid, systemClock } from "../model";
import { nextWork, planTasks } from "../engine/planner";
import {
  addDays,
  dateInZone,
  displayDate,
  displayTime,
  localAt,
  zonedEpoch,
} from "../engine/time";
import {
  ScreenProps,
  Card,
  Row,
  Button,
  Body,
  Heading,
  Field,
  Choices,
  Toggle,
  Pill,
  Notice,
  ui,
} from "./components";
import { DateTimePickerField, TimePickerField } from "./DateTimePickers";
import { formatPickerDateTime, formatPickerTime } from "./pickerValues";

function pickerText(value: string, format: (value: string) => string): string {
  try {
    return format(value);
  } catch {
    return value;
  }
}

export function Plan({ state, change, notify }: ScreenProps) {
  const s = state.settings,
    today = dateInZone(systemClock, s.timezone),
    next = nextWork(state.entries, systemClock, s.timezone);
  const nextShiftTime = next?.start
    ? pickerText(next.start.slice(11, 16), (value) =>
        formatPickerTime(value, s.clockFormat),
      )
    : "";
  const [edit, setEdit] = useState<Task | null>(null),
    [includeDone, setIncludeDone] = useState(false);
  const slots = planTasks(state.tasks, state.entries, s, systemClock);
  function create(kind: Task["kind"] = "flexible", title = "") {
    setEdit({
      id: uid("task"),
      title,
      kind,
      minutes: 30,
      deadline: (next?.date ?? addDays(today, 7)) + "T18:00",
      earliest: localAt(systemClock.now(), s.timezone).slice(0, 16),
      windowStart: "09:00",
      windowEnd: "18:00",
      priority: 2,
      recurrence: "none",
      location: "",
      travelMinutes: 0,
      movable: kind !== "fixed",
      splittable: false,
      locked: kind === "fixed",
      scheduledStart: null,
      state: "pending",
      linkedShiftId: kind === "essential" ? next?.id : undefined,
    });
  }
  const put = (patch: Partial<Task>) =>
    setEdit((e) => (e ? { ...e, ...patch } : null));
  const action = (t: Task, patch: Partial<Task>) =>
    change((a) => ({
      ...a,
      tasks: a.tasks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)),
    }));
  function save() {
    if (!edit) return;
    try {
      if (!edit.title.trim()) throw Error("Give the task a name.");
      if (
        edit.minutes <= 0 ||
        !Number.isFinite(edit.minutes) ||
        edit.travelMinutes < 0
      )
        throw Error(
          "Enter a positive duration and non-negative travel allowance.",
        );
      const from = zonedEpoch(edit.earliest, s.timezone),
        deadline = zonedEpoch(edit.deadline, s.timezone);
      if (deadline < from) throw Error("Deadline must follow earliest time.");
      if (
        ![edit.windowStart, edit.windowEnd].every((x) =>
          /^([01]\d|2[0-3]):[0-5]\d$/.test(x),
        )
      )
        throw Error("Choose valid preferred window start and end times.");
      if (edit.scheduledStart) zonedEpoch(edit.scheduledStart, s.timezone);
      const task = {
        ...edit,
        ...(edit.kind === "fixed"
          ? {
              locked: true,
              movable: false,
              scheduledStart: edit.scheduledStart ?? edit.earliest,
            }
          : {}),
      };
      change((a) => ({
        ...a,
        tasks: [...a.tasks.filter((t) => t.id !== task.id), task],
      }));
      setEdit(null);
      notify(
        "Task saved. Conflicts remain visible; fixed commitments stay fixed.",
      );
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <View style={ui.stack}>
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ gap: 8 }}>
          <Heading>A practical plan.</Heading>
          <Body muted>
            Prepare for work. Protect sleep. Leave room for yourself.
          </Body>
        </View>
        <Button
          title="Add task / appointment"
          icon="plus"
          onPress={() => create()}
        />
      </Row>
      <Card>
        <Heading small>Prepare for my next shift</Heading>
        <Body>
          {next
            ? `${next.duty || next.category} · ${displayDate(next.date, s.dateFormat)}${nextShiftTime ? ` · ${nextShiftTime}` : ""}`
            : "No next duty recorded. Add your rota first."}
        </Body>
        <Body muted>
          Suggested task ideas are not saved until you choose one. Enter its
          duration, deadline and preferred window before saving.
        </Body>
        <Row>
          {[
            "Prepare lunch",
            "Iron work clothes",
            "Pack work bag",
            "Lay out clothes",
          ].map((title) => (
            <Button
              key={title}
              title={title}
              secondary
              small
              onPress={() => create("essential", title)}
            />
          ))}
        </Row>
        <Row>
          {[
            "Laundry",
            "Batch cooking",
            "Grocery shopping",
            "Exercise",
            "Personal project",
            "Haircut",
          ].map((title) => (
            <Button
              key={title}
              title={title}
              secondary
              small
              onPress={() =>
                create(title === "Haircut" ? "fixed" : "flexible", title)
              }
            />
          ))}
        </Row>
        <Body muted>
          Opening hours and appointments are only those you enter. No booking or
          business availability is inferred.
        </Body>
      </Card>
      {edit && (
        <Card>
          <Heading small>
            {state.tasks.some((t) => t.id === edit.id)
              ? "Edit task"
              : "New task or appointment"}
          </Heading>
          <Field
            label="Task name"
            value={edit.title}
            onChange={(v) => put({ title: v })}
          />
          <Choices
            values={["fixed", "essential", "flexible", "optional"]}
            value={edit.kind}
            onChange={(v) =>
              put({
                kind: v,
                movable: v !== "fixed",
                locked: v === "fixed",
                linkedShiftId: v === "essential" ? next?.id : undefined,
              })
            }
          />
          <Body muted>
            Use fixed for appointments, responsibilities or protected family
            time. Essential tasks can follow the next recorded duty.
          </Body>
          <Row>
            <Field
              label="Duration (minutes)"
              value={String(edit.minutes)}
              numeric
              onChange={(v) => /^\d*$/.test(v) && put({ minutes: Number(v) })}
            />
            <Field
              label="Travel allowance (minutes)"
              value={String(edit.travelMinutes)}
              numeric
              onChange={(v) =>
                /^\d*$/.test(v) && put({ travelMinutes: Number(v) })
              }
              hint="Reserved before the task; include any extra occupied travel in its total duration."
            />
          </Row>
          <Body muted>Times use {s.timezone}.</Body>
          <DateTimePickerField
            label="Earliest / fixed start"
            value={edit.earliest}
            onChange={(v) => put({ earliest: v })}
            settings={s}
          />
          <DateTimePickerField
            label="Deadline"
            value={edit.deadline}
            onChange={(v) => put({ deadline: v })}
            settings={s}
          />
          <Row>
            <TimePickerField
              label="Preferred window start"
              value={edit.windowStart}
              onChange={(v) => put({ windowStart: v })}
              clockFormat={s.clockFormat}
            />
            <TimePickerField
              label="Preferred window end"
              value={edit.windowEnd}
              onChange={(v) => put({ windowEnd: v })}
              clockFormat={s.clockFormat}
            />
          </Row>
          <Field
            label="Location (optional)"
            value={edit.location}
            onChange={(v) => put({ location: v })}
          />
          <Body muted>Priority</Body>
          <Choices
            values={["1", "2", "3"]}
            value={String(edit.priority)}
            onChange={(v) => put({ priority: Number(v) })}
          />
          <Body muted>Recurrence · within the entered date range</Body>
          <Choices
            values={["none", "daily", "weekly"]}
            value={edit.recurrence}
            onChange={(v) => put({ recurrence: v })}
          />
          <Toggle
            label="May be moved"
            value={edit.movable}
            onChange={(v) => put({ movable: v })}
          />
          <Toggle
            label="May be split across available slots"
            value={edit.splittable}
            onChange={(v) => put({ splittable: v })}
          />
          <Toggle
            label="Lock at entered time"
            value={edit.locked}
            onChange={(v) =>
              put({
                locked: v,
                scheduledStart: v
                  ? (edit.scheduledStart ?? edit.earliest)
                  : null,
              })
            }
          />
          {(edit.locked || edit.kind === "fixed") && (
            <>
              <Body muted>
                Locked start sets this commitment’s appointment time. Changing
                earliest time keeps an existing locked start.
              </Body>
              <DateTimePickerField
                label="Locked start"
                value={edit.scheduledStart ?? edit.earliest}
                onChange={(v) => put({ scheduledStart: v })}
                settings={s}
              />
            </>
          )}
          <Row>
            <Button title="Save task" onPress={save} />
            <Button title="Cancel" secondary onPress={() => setEdit(null)} />
          </Row>
        </Card>
      )}
      <Row style={{ justifyContent: "space-between" }}>
        <Heading small>Your tasks & commitments</Heading>
        <Button
          title={includeDone ? "Hide completed" : "Show completed"}
          secondary
          small
          onPress={() => setIncludeDone(!includeDone)}
        />
      </Row>
      {state.tasks
        .filter(
          (t) => includeDone || !["completed", "skipped"].includes(t.state),
        )
        .map((t) => {
          const occurrences = slots.filter((p) => p.taskId === t.id),
            p = occurrences[0];
          return (
            <Card key={t.id}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={ui.section}>
                  <Pill
                    text={`${t.kind} · ${t.state}${t.locked ? " · locked" : ""}`}
                  />
                  <Heading small>{t.title}</Heading>
                </View>
                <Button
                  title="Edit / move"
                  secondary
                  small
                  icon="edit-2"
                  onPress={() => setEdit({ ...t })}
                />
              </Row>
              <Body>
                {t.minutes} min · Deadline{" "}
                {pickerText(t.deadline, (value) =>
                  formatPickerDateTime(value, s.dateFormat, s.clockFormat),
                )}
                {t.recurrence === "none" ? "" : ` · ${t.recurrence}`}
              </Body>
              {occurrences.slice(0, 8).map((o, i) => (
                <View key={i} style={ui.section}>
                  {o.start !== null ? (
                    <Body>
                      {displayDate(
                        localAt(o.start, s.timezone).slice(0, 10),
                        s.dateFormat,
                      )}{" "}
                      · {displayTime(o.start, s.timezone, s.clockFormat)}
                      {o.end !== null
                        ? `–${displayTime(o.end, s.timezone, s.clockFormat)}`
                        : ""}
                      {o.parts ? ` · ${o.parts.length} separate slots` : ""}
                    </Body>
                  ) : (
                    <Notice>{o.reason}</Notice>
                  )}
                  {o.parts?.map((part, j) => (
                    <Body muted key={j}>
                      Slot {j + 1}:{" "}
                      {displayDate(
                        localAt(part.start, s.timezone).slice(0, 10),
                        s.dateFormat,
                      )}{" "}
                      {displayTime(part.start, s.timezone, s.clockFormat)}–
                      {displayTime(part.end, s.timezone, s.clockFormat)}
                    </Body>
                  ))}
                  {o.conflict ? (
                    <Notice error>{o.conflict}</Notice>
                  ) : (
                    o.start !== null && (
                      <Body muted style={{ fontSize: 12 }}>
                        Why this slot? {o.reason}
                      </Body>
                    )
                  )}
                </View>
              ))}
              {occurrences.length > 8 && (
                <Body muted>
                  {occurrences.length - 8} further occurrences in the 14-day
                  plan.
                </Body>
              )}
              {t.state === "deferred" && (
                <Body muted>
                  Deferred. Choose “Find another slot” to check availability
                  again.
                </Body>
              )}
              <Row>
                {!["completed", "skipped"].includes(t.state) && (
                  <>
                    <Button
                      title="Accept"
                      small
                      secondary
                      disabled={
                        p?.start === null ||
                        p?.start === undefined ||
                        !!p?.conflict
                      }
                      onPress={() => action(t, { state: "accepted" })}
                    />
                    <Button
                      title={t.locked ? "Unlock" : "Lock"}
                      small
                      secondary
                      disabled={p?.start === null || p?.start === undefined}
                      onPress={() =>
                        action(t, {
                          locked: !t.locked,
                          scheduledStart: p?.start
                            ? localAt(p.start, s.timezone).slice(0, 16)
                            : t.scheduledStart,
                        })
                      }
                    />
                    <Button
                      title={
                        t.recurrence === "none"
                          ? "Complete"
                          : "Complete next occurrence"
                      }
                      small
                      icon="check"
                      onPress={() =>
                        action(
                          t,
                          t.recurrence !== "none" && p?.occurrenceDate
                            ? {
                                occurrenceStates: {
                                  ...t.occurrenceStates,
                                  [p.occurrenceDate]: "completed",
                                },
                              }
                            : { state: "completed" },
                        )
                      }
                    />
                    <Button
                      title={
                        t.recurrence === "none"
                          ? "Skip"
                          : "Skip next occurrence"
                      }
                      small
                      secondary
                      onPress={() =>
                        action(
                          t,
                          t.recurrence !== "none" && p?.occurrenceDate
                            ? {
                                occurrenceStates: {
                                  ...t.occurrenceStates,
                                  [p.occurrenceDate]: "skipped",
                                },
                              }
                            : { state: "skipped" },
                        )
                      }
                    />
                    <Button
                      title={t.recurrence === "none" ? "Defer" : "Defer series"}
                      small
                      secondary
                      onPress={() => action(t, { state: "deferred" })}
                    />
                  </>
                )}
                <Button
                  title="Find another slot"
                  secondary
                  small
                  onPress={() => {
                    if (t.kind === "fixed" || t.locked || !t.movable) {
                      notify(
                        "This commitment is fixed. Edit it yourself to change its time.",
                      );
                      return;
                    }
                    action(t, {
                      state: "pending",
                      earliest: localAt(systemClock.now(), s.timezone).slice(
                        0,
                        16,
                      ),
                      scheduledStart: null,
                    });
                    notify(
                      "Availability checked again within the existing deadline and window. Edit the deadline if it has passed.",
                    );
                  }}
                />
              </Row>
            </Card>
          );
        })}
      {state.tasks.length === 0 && (
        <Card>
          <Body>
            No saved tasks yet. Start with one thing that will make your next
            shift easier.
          </Body>
        </Card>
      )}
    </View>
  );
}
