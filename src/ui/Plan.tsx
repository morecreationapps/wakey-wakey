import React, { useRef, useState } from "react";
import { View } from "react-native";
import { Task, uid, systemClock } from "../model";
import { planTasks, type TaskPlacement } from "../engine/planner";
import { planPreparation } from "../engine/preparation";
import {
  defaultPreparationTaskStart,
  suggestPreparationTask,
} from "../engine/taskSuggestions";
import { displayDate, displayTime, localAt } from "../engine/time";
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
import {
  applyTaskSuggestion,
  snapshotTaskPlacement,
  taskForEditing,
  taskForSaving,
  taskSuggestionOverrides,
  taskTimeProvenance,
  withOptionalTaskField,
  type TaskDraftField,
} from "./taskDraft";

function pickerText(value: string, format: (value: string) => string): string {
  try {
    return format(value);
  } catch {
    return value;
  }
}

export function Plan({ state, change, notify }: ScreenProps) {
  const s = state.settings,
    preparation = planPreparation(state.entries, state.tasks, s, systemClock),
    next = preparation.nextShift;
  const nextShiftTime = next?.start
    ? pickerText(next.start.slice(11, 16), (value) =>
        formatPickerTime(value, s.clockFormat),
      )
    : "";
  const [edit, setEdit] = useState<Task | null>(null),
    [includeDone, setIncludeDone] = useState(false),
    [suggestionNotice, setSuggestionNotice] = useState(""),
    [suggestionConflict, setSuggestionConflict] = useState("");
  const editedFields = useRef(new Set<TaskDraftField>());
  const editingSavedTask = useRef(false);
  const slots = next
    ? preparation.placements
    : planTasks(state.tasks, state.entries, s, systemClock);
  function suggest(task: Task): Task {
    if (editingSavedTask.current) return task;
    const overrides = {
      id: task.id,
      kind: task.kind,
      movable: task.movable,
      locked: task.locked,
      ...taskSuggestionOverrides(task, editedFields.current),
    };
    const suggestion =
      suggestPreparationTask(
        task.title,
        state.entries,
        state.tasks,
        s,
        systemClock,
        overrides,
        next,
      ) ??
      (task.linkedShiftId
        ? defaultPreparationTaskStart(
            state.entries,
            state.tasks,
            s,
            systemClock,
            overrides,
            next,
          )
        : null);
    setSuggestionNotice(suggestion?.explanation ?? "");
    setSuggestionConflict(suggestion?.conflict ?? "");
    return suggestion
      ? applyTaskSuggestion(task, suggestion, editedFields.current)
      : task;
  }
  function create(
    kind: Task["kind"] = "flexible",
    title = "",
    forPreparation = true,
  ) {
    editedFields.current = new Set();
    editingSavedTask.current = false;
    setEdit(
      suggest({
        id: uid("task"),
        title,
        kind,
        minutes: 30,
        deadline: "",
        earliest:
          forPreparation && next
            ? ""
            : localAt(systemClock.now(), s.timezone).slice(0, 16),
        windowStart: "",
        windowEnd: "",
        priority: 2,
        recurrence: "none",
        location: "",
        travelMinutes: 0,
        movable: kind !== "fixed",
        splittable: false,
        locked: kind === "fixed",
        scheduledStart: null,
        state: "pending",
        linkedShiftId: forPreparation ? next?.id : undefined,
        omittedFields: [
          "deadline",
          "windowStart",
          "windowEnd",
          "travelMinutes",
        ],
      }),
    );
  }
  function put(patch: Partial<Task>, explicitTimeSelection = false) {
    if (!edit) return;
    for (const field of Object.keys(patch) as TaskDraftField[])
      editedFields.current.add(field);
    setEdit(
      suggest(taskTimeProvenance({ ...edit, ...patch }, explicitTimeSelection)),
    );
  }
  function beginEditing(task: Task) {
    editingSavedTask.current = true;
    editedFields.current = new Set();
    setSuggestionNotice("");
    setSuggestionConflict("");
    const placement = slots.find((p) => p.taskId === task.id);
    setEdit(
      taskForEditing(
        task,
        placement?.start !== null && placement?.start !== undefined
          ? localAt(placement.start, s.timezone).slice(0, 16)
          : undefined,
      ),
    );
  }
  const action = (t: Task, patch: Partial<Task>, placement?: TaskPlacement) =>
    change((a) => ({
      ...a,
      tasks: a.tasks.map((x) =>
        x.id === t.id
          ? taskTimeProvenance({
              ...(patch.state === "completed" || patch.state === "skipped"
                ? snapshotTaskPlacement(x, placement, s.timezone)
                : x),
              ...patch,
            })
          : x,
      ),
    }));
  function save() {
    if (!edit) return;
    try {
      const task = taskForSaving(edit, s.timezone);
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
          onPress={() => create("flexible", "", false)}
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
          Choose an idea or add your own task. Its day-before preparation time
          and duration are suggested in the form and remain editable. Nothing is
          saved until you choose Save task.
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
              onPress={() => create("flexible", title)}
            />
          ))}
        </Row>
        <Row>
          {[
            "Last meal before bed",
            "Shower for bed",
            "Wind down",
            "Go to sleep",
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
        <Button
          title="Add preparation task / appointment"
          icon="plus"
          onPress={() => create()}
        />
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
          {!!suggestionNotice && <Body muted>{suggestionNotice}</Body>}
          {!!suggestionConflict && <Notice error>{suggestionConflict}</Notice>}
          <Choices
            values={["fixed", "essential", "flexible", "optional"]}
            value={edit.kind}
            onChange={(v) =>
              put({
                kind: v,
                movable: v !== "fixed",
                locked: v === "fixed",
                ...(v === "essential" && next && !edit.linkedShiftId
                  ? { linkedShiftId: next.id }
                  : {}),
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
              label="Travel allowance (minutes, optional)"
              value={
                edit.omittedFields?.includes("travelMinutes")
                  ? ""
                  : String(edit.travelMinutes)
              }
              numeric
              onChange={(v) =>
                /^\d*$/.test(v) &&
                put({
                  travelMinutes: Number(v),
                  omittedFields: withOptionalTaskField(
                    edit,
                    "travelMinutes",
                    v === "",
                  ),
                })
              }
              hint="Reserved before the task; include any extra occupied travel in its total duration."
            />
          </Row>
          <Body muted>Times use {s.timezone}.</Body>
          <DateTimePickerField
            label={
              editingSavedTask.current && (edit.locked || edit.kind === "fixed")
                ? "Earliest permitted date and time"
                : "Start date and time"
            }
            value={edit.earliest}
            onChange={(v) =>
              put(
                {
                  earliest: v,
                  ...(!editingSavedTask.current ||
                  (!edit.locked && edit.kind !== "fixed")
                    ? { scheduledStart: v }
                    : {}),
                },
                true,
              )
            }
            settings={s}
          />
          <DateTimePickerField
            label="Deadline (optional)"
            value={edit.deadline}
            onChange={(v) => put({ deadline: v })}
            settings={s}
            allowClear
          />
          <Row>
            <TimePickerField
              label="Preferred window start (optional)"
              value={edit.windowStart}
              onChange={(v) => put({ windowStart: v })}
              clockFormat={s.clockFormat}
              allowClear
            />
            <TimePickerField
              label="Preferred window end (optional)"
              value={edit.windowEnd}
              onChange={(v) => put({ windowEnd: v })}
              clockFormat={s.clockFormat}
              allowClear
            />
          </Row>
          <Body muted>
            Deadline, preferred window, travel and location are optional. Leave
            any details that do not apply blank.
          </Body>
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
                ...(v
                  ? { scheduledStart: edit.scheduledStart ?? edit.earliest }
                  : editingSavedTask.current
                    ? { scheduledStart: null }
                    : {}),
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
                onChange={(v) => put({ scheduledStart: v }, true)}
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
            p = occurrences[0],
            missingOccurrence = t.recurrence !== "none" && !p?.occurrenceDate;
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
                  onPress={() => beginEditing(t)}
                />
              </Row>
              <Body>
                {t.minutes} min
                {!t.omittedFields?.includes("deadline") &&
                  ` · Deadline ${pickerText(t.deadline, (value) =>
                    formatPickerDateTime(value, s.dateFormat, s.clockFormat),
                  )}`}
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
              {missingOccurrence && (
                <Body muted>
                  No next occurrence is scheduled. Review this task’s date range
                  before completing or skipping an occurrence.
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
                      disabled={missingOccurrence}
                      onPress={() =>
                        !missingOccurrence &&
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
                          p,
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
                      disabled={missingOccurrence}
                      onPress={() =>
                        !missingOccurrence &&
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
                          p,
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
