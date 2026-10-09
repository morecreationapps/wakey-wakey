import React, { useState } from "react";
import { View, Pressable, Text } from "react-native";
import { RotaEntry, Settings, systemClock, uid } from "../model";
import {
  planShift,
  transitions,
  workBounds,
  type ShiftPlan,
} from "../engine/planner";
import {
  completePreparationTask,
  planPreparation,
  type PreparationRow,
} from "../engine/preparation";
import {
  dateInZone,
  addDays,
  displayDate,
  isWrittenDateFormat,
  displayTime,
  localAt,
  zonedEpoch,
} from "../engine/time";
import {
  ScreenProps,
  useTheme,
  Card,
  Row,
  Button,
  Body,
  Heading,
  Label,
  Field,
  Choices,
  Pill,
  Notice,
  Icon,
  ui,
} from "./components";
import { DatePickerField, DateTimePickerField } from "./DateTimePickers";
import { formatPickerDateTime, formatPickerTime } from "./pickerValues";
import { snapshotTaskPlacement } from "./taskDraft";
import { shiftDayPanels } from "../engine/shiftDayPanels";

function MissingInputs({
  items,
  onSettings,
}: {
  items: string[];
  onSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={ui.section}>
      <Notice>
        Provisional · {items.length} inputs or confirmations still needed.
      </Notice>
      <Button
        title={open ? "Hide missing inputs" : "Review missing inputs"}
        secondary
        small
        onPress={() => setOpen(!open)}
      />
      {open && <Notice>{items.join(" ")}</Notice>}
      {onSettings && (
        <Button
          title="Complete my settings"
          secondary
          small
          icon="settings"
          onPress={onSettings}
        />
      )}
    </View>
  );
}
function SleepDutyCard({
  entry,
  state,
}: {
  entry: RotaEntry;
  state: ScreenProps["state"];
}) {
  const [open, setOpen] = useState(false),
    s = state.settings,
    p = planShift(entry, s, state.entries, state.tasks);
  return (
    <Card>
      <Row style={{ justifyContent: "space-between" }}>
        <Heading small>
          {displayDate(entry.date, s.dateFormat)} ·{" "}
          {entry.duty || entry.category}
        </Heading>
        <Pill text={p.provisional ? "Provisional" : "Planned opportunity"} />
      </Row>
      <Body muted>
        {entry.category} ·{" "}
        {entry.start
          ? formatPickerTime(entry.start.slice(11, 16), s.clockFormat)
          : "Start needed"}
        –
        {entry.end
          ? formatPickerTime(entry.end.slice(11, 16), s.clockFormat)
          : "Finish needed"}{" "}
        · {entry.timezone}
      </Body>
      <Row>
        {p.events
          .filter((e) => ["bedtime", "wake"].includes(e.kind))
          .map((e) => (
            <Pill
              key={e.kind}
              text={`${e.label}: ${displayTime(e.at, entry.timezone, s.clockFormat)}`}
            />
          ))}
      </Row>
      {p.conflicts.map((x) => (
        <Notice error key={x}>
          {x}
        </Notice>
      ))}
      <Button
        title={
          open
            ? "Hide detailed plan"
            : `View plan for ${displayDate(entry.date, s.dateFormat)}`
        }
        secondary
        small
        onPress={() => setOpen(!open)}
      />
      {open && <PlanTimeline entry={entry} state={state} />}
    </Card>
  );
}
type TimelineIcon = React.ComponentProps<typeof Icon>["name"];

function timelineIcon(kind: string): TimelineIcon {
  if (kind === "departure" || kind === "travel") return "navigation";
  if (kind === "wake") return "sun";
  if (kind === "workStart") return "briefcase";
  if (["bedtime", "sleepStart", "sleep", "windDown"].includes(kind))
    return "moon";
  if (kind === "task" || kind === "routine") return "check-square";
  return "clock";
}

/** Both Today cards use the same time box and rounded activity box. */
function TimelineRow({
  label,
  at,
  end,
  minutes,
  status,
  why,
  icon,
  settings,
  timezone,
}: {
  label: string;
  at: number | null;
  end?: number | null;
  minutes?: number | null;
  status?: string;
  why: string;
  icon: TimelineIcon;
  settings: Settings;
  timezone: string;
}) {
  const c = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const startDate = at == null ? null : localAt(at, timezone).slice(0, 10);
  const endDate = end == null ? null : localAt(end, timezone).slice(0, 10);
  const untimedLabel = ["Completed", "Skipped", "Deferred"].includes(
    status ?? "",
  )
    ? status
    : "Not scheduled";
  const detail = [
    end == null
      ? null
      : `Until ${endDate !== startDate ? displayDate(endDate!, settings.dateFormat) + " " : ""}${displayTime(end, timezone, settings.clockFormat)}`,
    minutes == null ? null : `${minutes} min`,
    status,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${at == null ? "not scheduled" : `${displayDate(startDate!, settings.dateFormat)} ${displayTime(at, timezone, settings.clockFormat)}`}${detail ? ", " + detail : ""}. ${at == null ? "View details" : "Why this time?"}`}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          flexDirection: "row",
          gap: 10,
          alignItems: "stretch",
          borderRadius: 12,
          minHeight: 44,
          outlineColor: c.accent,
          outlineWidth: focused || pressed ? 2 : 0,
          outlineStyle: "solid",
          outlineOffset: 2,
          transform: [{ translateY: pressed ? 1 : 0 }],
        })}
      >
        <View
          style={{
            width: 98,
            flexShrink: 0,
            justifyContent: "center",
            paddingHorizontal: 6,
            paddingVertical: 9,
            backgroundColor: c.accent,
            borderRadius: 12,
          }}
        >
          <Text
            style={{
              color: c.onAccent,
              fontSize: at == null ? 13 : 19,
              fontWeight: "500",
              letterSpacing: -0.6,
            }}
          >
            {at == null
              ? untimedLabel
              : displayTime(at, timezone, settings.clockFormat)}
          </Text>
          {startDate && (
            <Text style={{ color: c.onAccent, fontSize: 10, marginTop: 3 }}>
              {displayDate(startDate, settings.dateFormat)}
            </Text>
          )}
        </View>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 8,
            paddingVertical: 9,
            backgroundColor: c.accent,
            borderRadius: 12,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text
              style={{
                fontSize: 14,
                lineHeight: 20,
                fontWeight: "600",
                color: c.onAccent,
                textDecorationLine: expanded ? "underline" : "none",
              }}
            >
              {label}
            </Text>
            {!!detail && (
              <Text style={{ color: c.onAccent, fontSize: 11, lineHeight: 16 }}>
                {detail}
              </Text>
            )}
            <Text style={{ color: c.onAccent, fontSize: 11, lineHeight: 16 }}>
              {at == null ? "View details" : "Why this time?"}{" "}
              {expanded ? "−" : "+"}
            </Text>
          </View>
          <Icon name={icon} size={18} colour={c.onAccent} />
        </View>
      </Pressable>
      {expanded && (
        <View
          style={{
            padding: 11,
            backgroundColor: c.card,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.line,
          }}
        >
          <Body muted style={{ fontSize: 12 }}>
            {why}
          </Body>
        </View>
      )}
    </View>
  );
}

export function PlanTimeline({
  entry,
  state,
  plan,
  navigate,
  showMissingInputs = true,
}: {
  entry: RotaEntry;
  state: ScreenProps["state"];
  plan?: ShiftPlan;
  navigate?: (tab: string) => void;
  showMissingInputs?: boolean;
}) {
  const s = state.settings;
  const p = plan ?? planShift(entry, s, state.entries, state.tasks);
  return (
    <View style={ui.section}>
      {showMissingInputs && p.missing.length > 0 && (
        <MissingInputs
          items={p.missing}
          onSettings={navigate ? () => navigate("Settings") : undefined}
        />
      )}
      {p.conflicts.map((x) => (
        <Notice error key={x}>
          {x}
        </Notice>
      ))}
      {p.conflicts.length > 0 && navigate && (
        <Button
          title="Review tasks and conflicts"
          small
          secondary
          icon="alert-triangle"
          onPress={() => navigate("Plan")}
        />
      )}
      {p.events.map((e) => (
        <TimelineRow
          key={e.kind}
          label={e.label}
          at={e.at}
          why={e.why}
          icon={timelineIcon(e.kind)}
          settings={s}
          timezone={entry.timezone}
        />
      ))}
      <Body muted style={{ fontSize: 11 }}>
        Planned sleep is an opportunity, not measured sleep. Times use{" "}
        {entry.timezone}.
      </Body>
    </View>
  );
}
export function TransitionCard({
  transition,
  state,
}: {
  transition: ReturnType<typeof transitions>[number];
  state: ScreenProps["state"];
}) {
  const s = state.settings;
  return (
    <Card>
      <Row>
        <Icon name="shuffle" />
        <Label>Shift Transition</Label>
        <Pill
          text={transition.provisional ? "Provisional" : "Planning estimate"}
        />
      </Row>
      <Heading small>
        {transition.from === transition.to
          ? `Returning to ${transition.to} shifts`
          : `${transition.from} → ${transition.to}`}
      </Heading>
      <Body>
        Next pattern: {displayDate(transition.nextDate, s.dateFormat)}
      </Body>
      {transition.adjustmentDates.length > 0 && (
        <Body muted>
          Potential adjustment days:{" "}
          {transition.adjustmentDates
            .map((d) => displayDate(d, s.dateFormat))
            .join(", ")}
        </Body>
      )}
      {transition.advice.map((a) => (
        <Body key={a} muted style={{ fontSize: 13 }}>
          {a}
        </Body>
      ))}
      {transition.missing.length > 0 && (
        <MissingInputs items={transition.missing} />
      )}
      {transition.dailySteps?.map((x) => (
        <View key={x.date}>
          <Body>
            {displayDate(x.date, s.dateFormat)} · Bed{" "}
            {formatPickerDateTime(x.bedtime, s.dateFormat, s.clockFormat)} ·
            Wake {formatPickerDateTime(x.wake, s.dateFormat, s.clockFormat)}
          </Body>
          <Body muted style={{ fontSize: 12 }}>
            {x.why}
          </Body>
        </View>
      ))}
    </Card>
  );
}
/** Rows are already assigned to one selected-shift calendar date by the engine. */
function DayTimeline({
  rows,
  state,
  timezone,
  change,
  notify,
}: {
  rows: PreparationRow[];
  state: ScreenProps["state"];
  timezone: string;
  change: ScreenProps["change"];
  notify: ScreenProps["notify"];
}) {
  const [deleteRow, setDeleteRow] = useState<string | null>(null);
  const statusLabels: Record<string, string> = {
    pending: "Planned",
    accepted: "Accepted",
    completed: "Completed",
    skipped: "Skipped",
    deferred: "Deferred",
    planned: "Planned",
    "needs-input": "Needs input",
    conflict: "Needs review",
  };
  return (
    <View style={ui.section}>
      {rows.map((row) => {
        const task = state.tasks.find((task) => task.id === row.taskId);
        const confirming = deleteRow === row.id;
        return (
          <View key={row.id} style={{ gap: 8 }}>
            <TimelineRow
              label={row.label}
              at={row.at}
              end={row.end}
              minutes={row.minutes}
              status={
                row.taskId
                  ? (statusLabels[row.status] ?? row.status)
                  : undefined
              }
              why={row.why}
              icon={timelineIcon(row.kind)}
              settings={state.settings}
              timezone={timezone}
            />
            {row.conflict && <Notice error>{row.conflict}</Notice>}
            {task && (
              <View style={{ gap: 8 }}>
                {confirming && (
                  <Body>
                    Delete “{task.title}”
                    {task.recurrence !== "none"
                      ? " and all its repeating occurrences"
                      : ""}{" "}
                    from your planner?
                    {row.id.startsWith("shift-event:") &&
                      " The calculated bedtime or wind-down will remain in your shift schedule."}
                    {
                      " You can undo this using Undo recent edit for one minute."
                    }
                  </Body>
                )}
                <Row style={{ justifyContent: "flex-end" }}>
                  {confirming && (
                    <Button
                      title="Cancel"
                      accessibilityLabel={`Cancel deleting ${task.title}`}
                      small
                      secondary
                      onPress={() => setDeleteRow(null)}
                    />
                  )}
                  <Button
                    title={confirming ? "Confirm delete" : "Delete task"}
                    accessibilityLabel={`${confirming ? "Confirm delete" : "Delete task"}: ${task.title}`}
                    icon="trash-2"
                    small
                    secondary
                    danger
                    onPress={() => {
                      if (!confirming) {
                        setDeleteRow(row.id);
                        return;
                      }
                      change((current) => ({
                        ...current,
                        tasks: current.tasks.filter(
                          (item) => item.id !== task.id,
                        ),
                      }));
                      setDeleteRow(null);
                      notify(
                        `“${task.title}” deleted. Undo recent edit is available for one minute.`,
                      );
                    }}
                  />
                </Row>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

export function Today({
  state,
  change,
  notify,
  navigate,
}: {
  state: ScreenProps["state"];
  change: ScreenProps["change"];
  notify: ScreenProps["notify"];
  navigate: (tab: string) => void;
}) {
  const c = useTheme(),
    s = state.settings,
    today = dateInZone(systemClock, s.timezone);
  const [focusedTask, setFocusedTask] = useState<string | null>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const wide = contentWidth >= 800;
  const current = state.entries.find((e) => {
    try {
      const w = workBounds(e);
      return w && w.start <= systemClock.now() && w.end > systemClock.now();
    } catch {
      return false;
    }
  });
  const preparation = planPreparation(
    state.entries,
    state.tasks,
    s,
    systemClock,
  );
  const panels = shiftDayPanels(preparation, state.tasks, s);
  const placements = preparation.placements;
  const checklistNext = preparation.nextShift;
  const preparationTimezone = checklistNext?.timezone ?? s.timezone;
  const next = current ?? checklistNext;
  const todayEntries = state.entries.filter((e) => e.date === today);
  const restToday = !current && todayEntries.some((e) => e.status === "Rest");
  const pending = state.tasks.filter(
    (t) => !["completed", "skipped"].includes(t.state),
  );
  const prep = pending
    .filter(
      (t) =>
        t.kind === "essential" &&
        (!t.linkedShiftId || t.linkedShiftId === checklistNext?.id) &&
        (t.recurrence === "none" ||
          !preparation.preparationDate ||
          !["completed", "skipped"].includes(
            t.occurrenceStates?.[preparation.preparationDate] ?? "pending",
          )),
    )
    .slice(0, 4);
  const rowStyle = {
    flexDirection: wide ? ("row" as const) : ("column" as const),
    alignItems: "stretch" as const,
    gap: 18,
  };
  return (
    <View
      style={ui.stack}
      onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
    >
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ gap: 8 }}>
          <Label
            style={
              isWrittenDateFormat(s.dateFormat)
                ? { textTransform: "none" }
                : undefined
            }
          >
            {isWrittenDateFormat(s.dateFormat)
              ? displayDate(today, s.dateFormat)
              : new Intl.DateTimeFormat("en-GB", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  timeZone: s.timezone,
                }).format(new Date(systemClock.now()))}
          </Label>
          <Heading>
            {s.name ? `Hello, ${s.name}.` : "Make tomorrow easier."}
          </Heading>
        </View>
        <Pill text="YOUR ACCOUNT" />
      </Row>
      <View style={rowStyle}>
        <Card style={{ flex: wide ? 1 : undefined, minWidth: 0, padding: 26 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <Label>
              {current
                ? "Current duty"
                : restToday
                  ? "Today"
                  : "Your next duty"}
            </Label>
            <Icon
              name={restToday ? "sun" : "sunrise"}
              size={28}
              colour={c.accent}
            />
          </Row>
          <Text
            style={{
              fontSize: 42,
              color: c.ink,
              fontWeight: "500",
              letterSpacing: -1.6,
            }}
          >
            {restToday
              ? "Rest day"
              : next
                ? `${next.category} shift`
                : "No next duty recorded"}
          </Text>
          <Body>
            {next
              ? `${restToday ? "Next duty: " : ""}${next.duty || "Work"} · ${displayDate(next.date, s.dateFormat)} · ${next.start ? formatPickerTime(next.start.slice(11, 16), s.clockFormat) : "Start needed"}–${next.end ? formatPickerTime(next.end.slice(11, 16), s.clockFormat) : "Finish needed"}`
              : "No upcoming work duty is recorded."}
          </Body>
          <Row>
            <Pill
              text={
                current
                  ? "Today · Working now"
                  : restToday
                    ? "Today · Rest day"
                    : todayEntries.some((e) => e.status === "Work")
                      ? "Today · Working"
                      : todayEntries.some(
                            (e) =>
                              e.status === "Holiday" &&
                              e.leaveApproval === "confirmed",
                          )
                        ? "Today · Confirmed annual leave"
                        : todayEntries.some((e) => e.status === "Holiday")
                          ? "Today · Holiday requested"
                          : todayEntries.some((e) => e.status === "Sick")
                            ? "Today · Sick leave"
                            : todayEntries.some(
                                  (e) => e.status === "OtherLeave",
                                )
                              ? "Today · Other leave"
                              : "Today · Rota still needed"
              }
            />
            <Pill text={s.timezone} />
          </Row>
          <Body muted>
            {restToday
              ? "Today is a recorded rest day. The preparation plan follows your next actual work shift, including any further rest days or leave."
              : next
                ? "Prepare for the next actual workday. Your recorded commitments and planned sleep shape the available time."
                : "Record your rota to connect your shifts, sleep and daily preparation."}
          </Body>
          <Button
            title="Open my rota"
            secondary
            icon="calendar"
            onPress={() => navigate("Rota")}
          />
        </Card>
        <Card style={{ flex: wide ? 1 : undefined, minWidth: 0 }}>
          <Row>
            <Icon name="check-square" />
            <Heading small>Prepare for my next shift</Heading>
          </Row>
          <Body muted>
            {checklistNext
              ? `For ${checklistNext.duty || checklistNext.category} on ${displayDate(checklistNext.date, s.dateFormat)}`
              : "Your checklist follows the next recorded workday."}
          </Body>
          {prep.length === 0 ? (
            <>
              <Body>No essential tasks added yet.</Body>
              <Button
                title="Add preparation tasks"
                secondary
                icon="plus"
                onPress={() => navigate("Plan")}
              />
            </>
          ) : (
            prep.map((t) => {
              const slot = placements.find(
                (p) =>
                  p.taskId === t.id &&
                  (t.recurrence === "none" ||
                    p.occurrenceDate === preparation.preparationDate),
              );
              const needsOccurrence =
                t.recurrence !== "none" && !slot?.occurrenceDate;
              return (
                <View key={t.id} style={{ paddingVertical: 7, gap: 4 }}>
                  <Row>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Complete ${t.title}`}
                      accessibilityState={{
                        checked: t.state === "completed",
                        disabled: needsOccurrence,
                      }}
                      disabled={needsOccurrence}
                      onFocus={() => setFocusedTask(t.id)}
                      onBlur={() => setFocusedTask(null)}
                      onPress={() => {
                        if (needsOccurrence) return;
                        change((a) => ({
                          ...a,
                          tasks: a.tasks.map((x) =>
                            x.id === t.id
                              ? completePreparationTask(
                                  snapshotTaskPlacement(x, slot, s.timezone),
                                  slot?.occurrenceDate,
                                )
                              : x,
                          ),
                        }));
                        notify(
                          t.recurrence === "none"
                            ? "Task completed."
                            : "Next task occurrence completed.",
                        );
                      }}
                      style={({ pressed }) => ({
                        padding: t.state === "completed" ? 10 : 9,
                        backgroundColor:
                          t.state === "completed" ? c.accent : c.card,
                        borderRadius: 10,
                        borderWidth: t.state === "completed" ? 0 : 1,
                        borderStyle: needsOccurrence ? "dashed" : "solid",
                        borderColor: c.line,
                        outlineColor:
                          t.state === "completed" ? c.onAccent : c.accent,
                        outlineWidth: focusedTask === t.id || pressed ? 2 : 0,
                        outlineStyle: "solid",
                        outlineOffset: t.state === "completed" ? -3 : 1,
                        transform: [{ translateY: pressed ? 1 : 0 }],
                      })}
                    >
                      <Icon
                        name={
                          needsOccurrence
                            ? "lock"
                            : t.state === "completed"
                              ? "check"
                              : "square"
                        }
                        size={17}
                        colour={t.state === "completed" ? c.onAccent : c.accent}
                      />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                      <Body style={{ fontWeight: "600" }}>{t.title}</Body>
                      <Body muted style={{ fontSize: 12 }}>
                        {t.minutes} min ·{" "}
                        {slot?.start
                          ? `${displayDate(localAt(slot.start, preparationTimezone).slice(0, 10), s.dateFormat)} ${displayTime(slot.start, preparationTimezone, s.clockFormat)}`
                          : "Needs a feasible slot"}
                      </Body>
                      {needsOccurrence && (
                        <Body muted style={{ fontSize: 12 }}>
                          Choose an occurrence in Plan to complete this
                          recurring task.
                        </Body>
                      )}
                    </View>
                  </Row>
                  {!!slot?.conflict && <Notice>{slot.conflict}</Notice>}
                </View>
              );
            })
          )}
          <Button
            title="See my plan"
            secondary
            icon="arrow-right"
            onPress={() => navigate("Plan")}
          />
        </Card>
      </View>
      <View style={rowStyle}>
        <Card style={{ flex: wide ? 1 : undefined, minWidth: 0 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <Heading small>Shift Transition</Heading>
            <Icon name="shuffle" />
          </Row>
          <Pill
            text={
              checklistNext ? "Day-before preparation" : "Next shift needed"
            }
          />
          {checklistNext && panels.preparationDate ? (
            <>
              <Body style={{ fontWeight: "600" }}>
                {displayDate(panels.preparationDate, s.dateFormat)}
              </Body>
              <Body muted style={{ fontSize: 12 }}>
                The calendar day before{" "}
                {checklistNext.duty || checklistNext.category}. Planned
                activities appear in time order.
              </Body>
              <DayTimeline
                rows={panels.transitionRows}
                state={state}
                timezone={panels.timezone}
                change={change}
                notify={notify}
              />
              {panels.transitionRows.length === 0 && (
                <Body>
                  No activities are scheduled for the day before this shift.
                  Choose an idea or add a task in Prepare for my next shift.
                </Body>
              )}
              <Button
                title="Edit preparation tasks"
                small
                secondary
                icon="check-square"
                onPress={() => navigate("Plan")}
              />
              <Body muted style={{ fontSize: 11 }}>
                Times use {panels.timezone}.
              </Body>
            </>
          ) : (
            <>
              <Body>
                Add your next recorded work shift to see the previous day's
                preparation here.
              </Body>
              <Button
                title="Add my next shift"
                icon="calendar"
                onPress={() => navigate("Rota")}
              />
            </>
          )}
        </Card>
        <Card style={{ flex: wide ? 1 : undefined, minWidth: 0 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <Heading small>Shift Plan</Heading>
            <Icon name="clock" />
          </Row>
          {checklistNext && panels.shiftDate ? (
            <>
              <Pill text="Shift day" />
              <Body style={{ fontWeight: "600" }}>
                {displayDate(panels.shiftDate, s.dateFormat)}
              </Body>
              <DayTimeline
                rows={panels.shiftRows}
                state={state}
                timezone={panels.timezone}
                change={change}
                notify={notify}
              />
              {panels.shiftRows.length === 0 && (
                <Body>
                  No activities have a calculated time on this shift's date yet.
                </Body>
              )}
              {(panels.reviewRows.length > 0 ||
                panels.otherShiftEvents.length > 0) && (
                <View style={ui.section}>
                  {panels.reviewRows.length > 0 && (
                    <Button
                      title="Review tasks with no time or another date"
                      small
                      secondary
                      onPress={() => navigate("Plan")}
                    />
                  )}
                  {panels.otherShiftEvents.length > 0 && (
                    <Button
                      title="View the full shift and sleep plan"
                      small
                      secondary
                      onPress={() => navigate("Sleep")}
                    />
                  )}
                </View>
              )}
              <Body muted style={{ fontSize: 11 }}>
                Planned sleep is an opportunity, not measured sleep. Times use{" "}
                {panels.timezone}.
              </Body>
            </>
          ) : (
            <>
              <Body>
                Add your next recorded work shift to see its shift-day schedule
                here.
              </Body>
              <Button
                title="Add my next shift"
                icon="calendar"
                onPress={() => navigate("Rota")}
              />
            </>
          )}
        </Card>
      </View>
      {!!preparation.shiftPlan?.conflicts.length && (
        <Card>
          <Heading small>Plan needs review</Heading>
          {[...new Set(preparation.shiftPlan.conflicts)].map((conflict) => (
            <Notice error key={conflict}>
              {conflict}
            </Notice>
          ))}
          <Button
            title="Review tasks and conflicts"
            small
            secondary
            icon="alert-triangle"
            onPress={() => navigate("Plan")}
          />
        </Card>
      )}
      <Card>
        <Label>Room for recovery</Label>
        <Heading small>Sleep is part of the plan.</Heading>
        <Body muted>
          Chores fit around protected sleep. If everything cannot fit, we show
          the conflict and keep your target visible.
        </Body>
        <Button
          title="Sleep & wellbeing"
          secondary
          icon="moon"
          onPress={() => navigate("Sleep")}
        />
      </Card>
    </View>
  );
}
export function Sleep({ state, change, notify }: ScreenProps) {
  const s = state.settings,
    today = dateInZone(systemClock, s.timezone),
    [date, setDate] = useState(today),
    [bed, setBed] = useState(addDays(today, -1) + "T23:00"),
    [wake, setWake] = useState(today + "T07:00"),
    [minutes, setMinutes] = useState(""),
    [awakenings, setAwakenings] = useState(""),
    [rested, setRested] = useState("Okay"),
    [sleepy, setSleepy] = useState(false);
  const upcoming = state.entries.filter(
    (e) =>
      e.status === "Work" && e.date >= today && e.date <= addDays(today, 14),
  );
  const tr = transitions(state.entries, s, systemClock);
  return (
    <View style={ui.stack}>
      <Heading>Protect your sleep.</Heading>
      <Body muted>
        Sleep opportunities and shift changes, planned around your actual rota.
      </Body>
      <Card>
        <Row>
          <Pill
            text={`${s.sleepTarget === null ? "?" : s.sleepTarget / 60} h selected target`}
          />
          <Pill text="Planning estimates" />
        </Row>
        <Body>
          Adults commonly need 7–9 hours; individual needs differ. These plans
          do not measure sleep or assess whether you are safe to work.
        </Body>
        <Button
          title="I feel severely sleepy"
          danger
          icon="alert-triangle"
          onPress={() => setSleepy(!sleepy)}
        />
        {sleepy && (
          <Notice error>
            Do not drive or undertake safety-critical work while sleepy. Follow
            your workplace fatigue procedures, arrange a safe alternative
            journey and seek appropriate help. If sleepiness or persistent sleep
            problems affect daily life, seek medical advice.
          </Notice>
        )}
      </Card>
      {tr.map((t) => (
        <TransitionCard key={t.id} transition={t} state={state} />
      ))}
      <Heading small>Next 14 days</Heading>
      {upcoming.length === 0 && (
        <Card>
          <Body>
            No work duties in the next 14 days. Keep the longer-range rota
            visible in Rota.
          </Body>
        </Card>
      )}
      {upcoming.map((e) => (
        <SleepDutyCard key={e.id} entry={e} state={state} />
      ))}
      <Card>
        <Heading small>Optional sleep diary</Heading>
        <Body muted>
          Self-reported estimates, never automatically measured. Past logs
          remain separate from generated plans.
        </Body>
        <DatePickerField
          label="Diary date"
          value={date}
          onChange={setDate}
          settings={s}
        />
        <Row>
          <DateTimePickerField
            label="Approximate bedtime"
            value={bed}
            onChange={setBed}
            settings={s}
          />
          <DateTimePickerField
            label="Wake date and time"
            value={wake}
            onChange={setWake}
            settings={s}
          />
        </Row>
        <Row>
          <Field
            label="Estimated minutes asleep (optional)"
            value={minutes}
            numeric
            onChange={setMinutes}
          />
          <Field
            label="Awakenings (optional)"
            value={awakenings}
            numeric
            onChange={setAwakenings}
          />
        </Row>
        <Choices
          values={["Rested", "Okay", "Tired", "Very sleepy"]}
          value={rested}
          onChange={setRested}
        />
        <Button
          title="Save check-in"
          onPress={() => {
            try {
              const b = zonedEpoch(bed, s.timezone),
                w = zonedEpoch(wake, s.timezone);
              if (w <= b) throw Error("Wake must follow bedtime.");
              addDays(date, 0);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
                throw Error("Choose a valid diary date.");
              if (
                (minutes && !/^\d+$/.test(minutes)) ||
                (awakenings && !/^\d+$/.test(awakenings))
              )
                throw Error("Use whole non-negative numbers.");
              if (minutes && Number(minutes) > (w - b) / 60000)
                throw Error(
                  "Estimated sleep cannot exceed the recorded time in bed.",
                );
              change((a) => ({
                ...a,
                sleepLogs: [
                  ...a.sleepLogs,
                  {
                    id: uid("log"),
                    date,
                    bedtime: bed,
                    wake,
                    estimatedMinutes: minutes ? Number(minutes) : null,
                    awakenings: awakenings ? Number(awakenings) : null,
                    rested,
                  },
                ],
              }));
              notify("Self-reported check-in saved.");
              if (rested === "Very sleepy") setSleepy(true);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
        {state.sleepLogs.length > 0 && (
          <Body muted>
            {state.sleepLogs.length} check-ins,{" "}
            {displayDate(
              state.sleepLogs.map((l) => l.date).sort()[0],
              s.dateFormat,
            )}{" "}
            to{" "}
            {displayDate(
              state.sleepLogs
                .map((l) => l.date)
                .sort()
                .at(-1)!,
              s.dateFormat,
            )}
            . Missing dates are unrecorded; no sleep-debt estimate is
            calculated.
          </Body>
        )}
        {[...state.sleepLogs]
          .reverse()
          .slice(0, 10)
          .map((l) => (
            <Body key={l.id}>
              {displayDate(l.date, s.dateFormat)} ·{" "}
              {l.estimatedMinutes === null
                ? "Sleep duration unknown"
                : `${(l.estimatedMinutes / 60).toFixed(1)} h estimated`}{" "}
              · {l.rested}
            </Body>
          ))}
      </Card>
      <Card>
        <Heading small>Sleep information & sources</Heading>
        <Body>
          Keep a quiet, dark, comfortable sleep environment and allow time to
          relax before bed. Protect rest when arranging domestic tasks around
          shifts. Persistent sleep problems affecting daily life deserve medical
          advice.
        </Body>
        <Body muted>
          The optional caffeine reminder starts six hours before planned
          bedtime, based on NHS guidance. People respond differently; this
          interval is not a guarantee.
        </Body>
        <Body muted>
          Source content checked: 7 October 2026. NHS Insomnia page reviewed by
          its publisher on 19 March 2024; HSE shift-worker page shows 29 October
          2024. Specialist review is still required before public release.
        </Body>
        <Body>
          <Text
            onPress={() =>
              import("react-native").then(({ Linking }) =>
                Linking.openURL("https://www.nhs.uk/conditions/insomnia/"),
              )
            }
            style={{ textDecorationLine: "underline" }}
          >
            NHS — Insomnia
          </Text>
        </Body>
        <Body>
          <Text
            onPress={() =>
              import("react-native").then(({ Linking }) =>
                Linking.openURL(
                  "https://www.hse.gov.uk/humanfactors/topics/shift-workers.htm",
                ),
              )
            }
            style={{ textDecorationLine: "underline" }}
          >
            HSE — Hints and tips for shift-workers
          </Text>
        </Body>
        <Notice>
          Transition changes use a transparent gradual planning heuristic. They
          cannot measure or reset your body clock. Specialist overnight-shift
          coaching is withheld.
        </Notice>
      </Card>
    </View>
  );
}
