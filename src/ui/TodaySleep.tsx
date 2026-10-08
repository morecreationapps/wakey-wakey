import React, { useState } from "react";
import { View, Pressable, Text } from "react-native";
import { RotaEntry, systemClock, uid } from "../model";
import {
  nextWork,
  planShift,
  transitions,
  planTasks,
  workBounds,
} from "../engine/planner";
import {
  dateInZone,
  addDays,
  displayDate,
  displayLocalDateTime,
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
function MissingInputs({ items }: { items: string[] }) {
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
        {entry.category} · {entry.start?.split("T")[1]}–
        {entry.end?.split("T")[1]} · {entry.timezone}
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
export function PlanTimeline({
  entry,
  state,
}: {
  entry: RotaEntry;
  state: ScreenProps["state"];
}) {
  const [expanded, setExpanded] = useState<string | null>(null),
    [focusedEvent, setFocusedEvent] = useState<string | null>(null),
    c = useTheme(),
    s = state.settings;
  const p = planShift(entry, s, state.entries, state.tasks),
    tz = entry.timezone;
  return (
    <View style={ui.section}>
      {p.missing.length > 0 && <MissingInputs items={p.missing} />}
      {p.conflicts.map((x) => (
        <Notice error key={x}>
          {x}
        </Notice>
      ))}
      {p.events.map((e) => (
        <View key={e.kind} style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Why this time? ${e.label}`}
            onFocus={() => setFocusedEvent(e.kind)}
            onBlur={() => setFocusedEvent(null)}
            onPress={() => setExpanded(expanded === e.kind ? null : e.kind)}
            style={({ pressed }) => ({
              flexDirection: "row",
              gap: 10,
              alignItems: "stretch",
              borderRadius: 12,
              outlineColor: c.accent,
              outlineWidth: focusedEvent === e.kind || pressed ? 2 : 0,
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
                  fontSize: 19,
                  fontWeight: "500",
                  letterSpacing: -0.6,
                }}
              >
                {displayTime(e.at, tz, s.clockFormat)}
              </Text>
              <Text style={{ color: c.onAccent, fontSize: 10, marginTop: 3 }}>
                {displayDate(localAt(e.at, tz).slice(0, 10), s.dateFormat)}
              </Text>
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
              <View style={{ flex: 1, minWidth: 0 }}>
                <Body
                  style={{
                    fontWeight: "600",
                    color: c.onAccent,
                    backgroundColor: c.accent,
                    textDecorationLine:
                      expanded === e.kind ? "underline" : "none",
                  }}
                >
                  {e.label}
                </Body>
                <Body
                  style={{
                    fontSize: 11,
                    color: c.onAccent,
                    backgroundColor: c.accent,
                  }}
                >
                  Why this time? {expanded === e.kind ? "−" : "+"}
                </Body>
              </View>
              <Icon
                name={
                  e.kind === "departure"
                    ? "navigation"
                    : e.kind === "wake"
                      ? "sun"
                      : e.kind === "workStart"
                        ? "briefcase"
                        : e.kind === "bedtime" || e.kind === "sleepStart"
                          ? "moon"
                          : "clock"
                }
                size={18}
                colour={c.onAccent}
              />
            </View>
          </Pressable>
          {expanded === e.kind && (
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
                {e.why}
              </Body>
            </View>
          )}
        </View>
      ))}
      <Body muted style={{ fontSize: 11 }}>
        Planned sleep is an opportunity, not measured sleep. Times use {tz}.
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
        <Label>Shift transition</Label>
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
            {s.dateFormat === "LONG"
              ? displayLocalDateTime(x.bedtime, s.dateFormat)
              : x.bedtime}{" "}
            · Wake{" "}
            {s.dateFormat === "LONG"
              ? displayLocalDateTime(x.wake, s.dateFormat)
              : x.wake}
          </Body>
          <Body muted style={{ fontSize: 12 }}>
            {x.why}
          </Body>
        </View>
      ))}
    </Card>
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
  const current = state.entries.find((e) => {
    try {
      const w = workBounds(e);
      return w && w.start <= systemClock.now() && w.end > systemClock.now();
    } catch {
      return false;
    }
  });
  const next = current ?? nextWork(state.entries, systemClock, s.timezone),
    checklistNext = nextWork(state.entries, systemClock, s.timezone);
  const tr = transitions(state.entries, s, systemClock).find(
    (t) => t.nextDate <= addDays(today, 14),
  );
  const placements = planTasks(state.tasks, state.entries, s, systemClock);
  const pending = state.tasks.filter(
    (t) => !["completed", "skipped"].includes(t.state),
  );
  const prep = pending
    .filter(
      (t) =>
        t.kind === "essential" &&
        (!t.linkedShiftId || t.linkedShiftId === checklistNext?.id),
    )
    .slice(0, 4);
  const todayEntries = state.entries.filter((e) => e.date === today);
  return (
    <View style={ui.stack}>
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ gap: 8 }}>
          <Label
            style={
              s.dateFormat === "LONG" ? { textTransform: "none" } : undefined
            }
          >
            {s.dateFormat === "LONG"
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
      <View style={[ui.grid, { alignItems: "flex-start" }]}>
        <View style={[ui.col, ui.stack, { flex: 1.45 }]}>
          <Card
            style={{
              backgroundColor: c.card,
              borderColor: c.line,
              padding: 26,
            }}
          >
            <Row style={{ justifyContent: "space-between" }}>
              <Label>{current ? "Current duty" : "Your next duty"}</Label>
              <Icon name="sunrise" size={28} colour={c.accent} />
            </Row>
            <Text
              style={{
                fontSize: 42,
                color: c.ink,
                fontWeight: "500",
                letterSpacing: -1.6,
              }}
            >
              {next?.status === "Work"
                ? `${next.category} shift`
                : "A little breathing space"}
            </Text>
            <Body>
              {next
                ? `${next.duty || "Work"} · ${displayDate(next.date, s.dateFormat)} · ${next.start?.split("T")[1]}–${next.end?.split("T")[1]}`
                : "No upcoming work duty is recorded."}
            </Body>
            <Row>
              <Pill
                text={
                  todayEntries.some((e) => e.status === "Rest")
                    ? "Today · Confirmed rest"
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
              {next
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
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Heading small>
                {next
                  ? "The plan around your next shift"
                  : "Your daily timeline"}
              </Heading>
              <Icon name="clock" colour={c.muted} />
            </Row>
            {next ? (
              <PlanTimeline entry={next} state={state} />
            ) : (
              <Body muted>
                Add a duty to see preparation, departure and sleep opportunities
                here.
              </Body>
            )}
          </Card>
        </View>
        <View style={[ui.col, ui.stack]}>
          <Card>
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
                const slot = placements.find((p) => p.taskId === t.id);
                return (
                  <View key={t.id} style={{ paddingVertical: 7, gap: 4 }}>
                    <Row>
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Complete ${t.title}`}
                        accessibilityState={{
                          checked: t.state === "completed",
                        }}
                        onFocus={() => setFocusedTask(t.id)}
                        onBlur={() => setFocusedTask(null)}
                        onPress={() => {
                          change((a) => ({
                            ...a,
                            tasks: a.tasks.map((x) =>
                              x.id === t.id
                                ? t.recurrence !== "none" &&
                                  slot?.occurrenceDate
                                  ? {
                                      ...x,
                                      occurrenceStates: {
                                        ...x.occurrenceStates,
                                        [slot.occurrenceDate]: "completed",
                                      },
                                    }
                                  : { ...x, state: "completed" }
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
                          name={t.state === "completed" ? "check" : "square"}
                          size={17}
                          colour={
                            t.state === "completed" ? c.onAccent : c.accent
                          }
                        />
                      </Pressable>
                      <View style={{ flex: 1 }}>
                        <Body style={{ fontWeight: "600" }}>{t.title}</Body>
                        <Body muted style={{ fontSize: 12 }}>
                          {t.minutes} min ·{" "}
                          {slot?.start
                            ? `${displayDate(localAt(slot.start, s.timezone).slice(0, 10), s.dateFormat)} ${displayTime(slot.start, s.timezone, s.clockFormat)}`
                            : "Needs a feasible slot"}
                        </Body>
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
          {tr && <TransitionCard transition={tr} state={state} />}
          <Card>
            <Label>Room for recovery</Label>
            <Heading small>Sleep is part of the plan.</Heading>
            <Body muted>
              Chores fit around protected sleep. If everything cannot fit, we
              show the conflict and keep your target visible.
            </Body>
            <Button
              title="Sleep & wellbeing"
              secondary
              icon="moon"
              onPress={() => navigate("Sleep")}
            />
          </Card>
        </View>
      </View>
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
        <Field label="Diary date YYYY-MM-DD" value={date} onChange={setDate} />
        <Row>
          <Field label="Approximate bedtime" value={bed} onChange={setBed} />
          <Field label="Wake date/time" value={wake} onChange={setWake} />
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
                throw Error("Use an ISO diary date.");
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
            {state.sleepLogs.map((l) => l.date).sort()[0]} to{" "}
            {state.sleepLogs
              .map((l) => l.date)
              .sort()
              .at(-1)}
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
