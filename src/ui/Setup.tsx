import React, { useState, useEffect } from "react";
import { View } from "react-native";
import { Settings, uid } from "../model";
import {
  Card,
  Field,
  Toggle,
  Choices,
  Button,
  Body,
  Row,
  Heading,
  Notice,
  ScreenProps,
  useTheme,
  ui,
  Pill,
} from "./components";
import { initialState, starterTemplates } from "../data/defaults";
import { nextWork, planShift } from "../engine/planner";
import { displayTime } from "../engine/time";
import { systemClock } from "../model";
const steps = [
  "Welcome",
  "Work",
  "Travel & preparation",
  "Sleep",
  "Daily life",
  "Review",
];
export function SettingsFields({
  state,
  change,
  section,
}: {
  state: ScreenProps["state"];
  change: ScreenProps["change"];
  section: number;
}) {
  const s = state.settings;
  const [timezoneDraft, setTimezoneDraft] = useState(s.timezone);
  const [timezoneError, setTimezoneError] = useState("");
  useEffect(() => setTimezoneDraft(s.timezone), [s.timezone]);
  function put<K extends keyof Settings>(key: K, value: Settings[K]) {
    change((a) => ({
      ...a,
      settings: {
        ...a.settings,
        [key]: value,
        origins: {
          ...a.settings.origins,
          [key]: value === null ? "needed" : "entered",
        },
      },
    }));
  }
  function num(key: keyof Settings, label: string, hint?: string) {
    const v = s[key] ?? (key === "caffeineBeforeBed" ? 360 : null);
    return (
      <Field
        key={key}
        label={label}
        value={v === null ? "" : String(v)}
        placeholder="Still needed"
        numeric
        onChange={(x) => {
          if (x === "" || /^\d+(\.\d+)?$/.test(x))
            put(key, x === "" ? null : (Number(x) as never));
        }}
        hint={
          hint ??
          (s.origins[key] === "suggested"
            ? "Suggested starting value — editable"
            : v === null
              ? "Still needed"
              : "Entered by you")
        }
      />
    );
  }
  function time(key: keyof Settings, label: string) {
    return (
      <Field
        label={label}
        value={String(s[key] ?? "")}
        placeholder="HH:mm · optional"
        onChange={(v) => put(key, (v || null) as never)}
        hint={
          s[key] === null
            ? "Still needed — affected plans stay provisional"
            : "Entered by you"
        }
      />
    );
  }
  if (section === 1)
    return (
      <View style={ui.stack}>
        <Row>
          <Field
            label="Name (optional)"
            value={s.name}
            onChange={(v) => put("name", v)}
          />
          <Field
            label="Job role (optional)"
            value={s.role}
            onChange={(v) => put("role", v)}
          />
        </Row>
        <Toggle
          label="Safety-critical work"
          value={s.safetyCritical}
          onChange={(v) => put("safetyCritical", v)}
          hint="Driving, machinery or other safety-critical activity"
        />
        <Field
          label="Work / rota timezone"
          value={timezoneDraft}
          onChange={setTimezoneDraft}
          hint="Edit then apply a recognised IANA timezone. Existing duties retain their recorded timezone."
        />
        <Button
          title="Apply rota timezone"
          secondary
          onPress={() => {
            try {
              new Intl.DateTimeFormat("en", {
                timeZone: timezoneDraft,
              }).format();
              setTimezoneError("");
              put("timezone", timezoneDraft);
              put("timezoneConfirmed", false);
            } catch {
              setTimezoneError(
                "Enter a recognised IANA timezone, such as Europe/London. Your saved timezone has not changed.",
              );
            }
          }}
        />
        {!!timezoneError && <Notice error>{timezoneError}</Notice>}
        <Body muted>Saved rota timezone: {s.timezone}</Body>
        <Toggle
          label="I confirm this is my rota timezone"
          value={s.timezoneConfirmed}
          onChange={(v) => put("timezoneConfirmed", v)}
        />
        <Body muted>Date format</Body>
        <Choices
          values={["UK", "ISO"]}
          value={s.dateFormat}
          onChange={(v) => put("dateFormat", v)}
        />
        <Body muted>Clock</Body>
        <Choices
          values={["24", "12"]}
          value={s.clockFormat}
          onChange={(v) => put("clockFormat", v)}
        />
        <Body muted>First day of week</Body>
        <Choices
          values={["Monday", "Sunday"]}
          value={s.firstDay}
          onChange={(v) => put("firstDay", v)}
        />
        <Body muted>
          Shift templates, rest days, leave and overtime are editable in Rota.
          No repeating cycle is assumed.
        </Body>
        <Row>
          {state.templates.map((t) => (
            <Pill key={t.id} text={`${t.category} ${t.start}–${t.end}`} />
          ))}
        </Row>
      </View>
    );
  if (section === 2)
    return (
      <View style={ui.stack}>
        <Field
          label="Travel mode"
          value={s.travelMode}
          onChange={(v) => put("travelMode", v)}
          placeholder="Car, bus, walking…"
        />
        <Row>
          {num("outboundMin", "Outbound minimum (minutes)")}
          {num("outboundMax", "Outbound maximum (minutes)")}
        </Row>
        <Body muted>
          Departure uses the upper estimate of the entered range.
        </Body>
        <Row>
          {num(
            "returnMinutes",
            "Return journey (minutes)",
            "Separate from outbound travel. Empty means unknown.",
          )}
          {num("arrivalBuffer", "Arrival buffer (minutes)")}
        </Row>
        <Heading small>Essential routine</Heading>
        {s.routines.map((r) => (
          <Card key={r.id}>
            <Field
              label="Routine name"
              value={r.name}
              onChange={(v) =>
                put(
                  "routines",
                  s.routines.map((x) =>
                    x.id === r.id ? { ...x, name: v } : x,
                  ),
                )
              }
            />
            <Field
              label="Total routine minutes"
              value={r.minutes === null ? "" : String(r.minutes)}
              numeric
              onChange={(v) => {
                if (v === "" || /^\d+$/.test(v))
                  put(
                    "routines",
                    s.routines.map((x) =>
                      x.id === r.id
                        ? { ...x, minutes: v === "" ? null : Number(v) }
                        : x,
                    ),
                  );
              }}
              hint="One total for the combined routine, not one duration per included activity."
            />
            <Field
              label="Included activities (comma separated)"
              value={r.includes.join(", ")}
              onChange={(v) =>
                put(
                  "routines",
                  s.routines.map((x) =>
                    x.id === r.id
                      ? {
                          ...x,
                          includes: v
                            .split(",")
                            .map((v) => v.trim().toLowerCase())
                            .filter(Boolean),
                        }
                      : x,
                  ),
                )
              }
            />
            <Button
              title="Remove routine"
              secondary
              small
              onPress={() =>
                put(
                  "routines",
                  s.routines.filter((x) => x.id !== r.id),
                )
              }
            />
          </Card>
        ))}
        <Button
          title="Add essential routine"
          icon="plus"
          secondary
          onPress={() =>
            put("routines", [
              ...s.routines,
              {
                id: uid("routine"),
                name: "Additional preparation",
                minutes: null,
                includes: [],
                essential: true,
              },
            ])
          }
        />
        <Toggle
          label="I have accounted for all essential preparation"
          value={s.additionalPrepConfirmed}
          onChange={(v) => put("additionalPrepConfirmed", v)}
          hint="Confirm whether breakfast, dressing and packing are included, or add their extra minutes above."
        />
        {num(
          "postWorkMinutes",
          "Necessary activities after work (minutes)",
          "Meals, washing and responsibilities after returning home. Enter 0 only if none.",
        )}
      </View>
    );
  if (section === 3)
    return (
      <View style={ui.stack}>
        <Notice>
          These are planning estimates. Adults commonly need 7–9 hours of sleep;
          individual needs differ. A chosen target does not establish fitness to
          drive.
        </Notice>
        <Row>
          {num("sleepTarget", "Sleep target (minutes)")}
          {num("latency", "Time to fall asleep (minutes)")}
          {num("windDown", "Wind-down (minutes)")}
        </Row>
        <Button
          title="Confirm the suggested durations"
          secondary
          onPress={() =>
            change((a) => ({
              ...a,
              settings: {
                ...a.settings,
                origins: {
                  ...a.settings.origins,
                  sleepTarget: "entered",
                  latency: "entered",
                  windDown: "entered",
                  arrivalBuffer: "entered",
                },
              },
            }))
          }
        />
        <Heading small>Usual times · 24-hour input</Heading>
        <Row>
          {time("earlyBed", "Early-shift bedtime")}
          {time("earlyWake", "Early-shift wake")}
        </Row>
        <Row>
          {time("lateBed", "Late-shift bedtime")}
          {time("lateWake", "Late-shift wake")}
        </Row>
        <Row>
          {time("restBed", "Rest-day bedtime")}
          {time("restWake", "Rest-day wake")}
        </Row>
        <Body muted>
          Leave unknown times blank. Late-shift waking is based on your
          preferences and commitments, never simply the preparation deadline.
        </Body>
        <Toggle
          label="Prefer a consistent wake-up time"
          value={s.consistentWake}
          onChange={(v) => put("consistentWake", v)}
        />
        {s.caffeine &&
          num(
            "caffeineBeforeBed",
            "Caffeine reminder before bedtime (minutes)",
            "Suggested initial interval: 360 minutes, based on NHS guidance. Effects vary.",
          )}
        <Toggle
          label="Show caffeine reminders"
          value={s.caffeine}
          onChange={(v) => {
            put("caffeine", v);
            put(
              "reminderKinds",
              v
                ? [...new Set([...s.reminderKinds, "caffeine"])]
                : s.reminderKinds.filter((k) => k !== "caffeine"),
            );
          }}
          hint="An editable starting interval of six hours before planned bedtime; effects vary."
        />
      </View>
    );
  return (
    <View style={ui.stack}>
      <Heading small>Make room for life</Heading>
      <Body muted>
        Add regular chores, fixed responsibilities, appointments and protected
        family time in Plan. Fixed or locked tasks remain where you put them.
      </Body>
      {num("freeMinutes", "Protected free time on rest days (minutes)")}
      <Body muted>
        Reminders start off. After reviewing your rota and plan, activate each
        reminder type in Settings. A wake-up reminder is an ordinary
        notification; use a separate phone alarm.
      </Body>
      <Heading small>Display</Heading>
      <Choices
        values={["light", "dark", "system"]}
        value={s.theme}
        onChange={(v) => put("theme", v)}
      />
    </View>
  );
}
export function Setup({ state, change, notify }: ScreenProps) {
  const c = useTheme(),
    step = state.settings.onboardingStep,
    s = state.settings;
  const previewEntries = state.entries;
  const next = nextWork(previewEntries, systemClock, s.timezone);
  const p = next ? planShift(next, s, previewEntries, state.tasks) : null;
  const choose = (kind: string) =>
    change((a) => {
      const nextSettings = {
        ...initialState().settings,
        onboardingStep: 1,
      };
      return {
        ...a,
        templates:
          kind === "scratch" ? [] : starterTemplates.map((x) => ({ ...x })),
        settings: {
          ...nextSettings,
          onboardingRotaPending: false,
        },
        entries: [],
      };
    });
  const forward = () => {
    if (step === 1) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: s.timezone }).format();
      } catch {
        notify("Enter a recognised IANA timezone, such as Europe/London.");
        return;
      }
      if (!s.timezoneConfirmed) {
        notify("Please explicitly confirm the timezone used by your rota.");
        return;
      }
    }
    if (
      step === 3 &&
      [
        "earlyBed",
        "earlyWake",
        "lateBed",
        "lateWake",
        "restBed",
        "restWake",
      ].some(
        (k) =>
          s[k as keyof Settings] &&
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s[k as keyof Settings])),
      )
    ) {
      notify("Use 24-hour HH:mm for usual sleep times, or leave them blank.");
      return;
    }
    change((a) => ({
      ...a,
      settings: { ...a.settings, onboardingStep: Math.min(step + 1, 5) },
    }));
  };
  return (
    <View
      style={{ maxWidth: 740, width: "100%", alignSelf: "center", gap: 22 }}
    >
      <Row style={{ justifyContent: "space-between" }}>
        <Pill text={`SETUP · ${step + 1} OF 6`} />
        <Body muted pill>
          Your answers save as you go
        </Body>
      </Row>
      <Row style={{ backgroundColor: c.card }}>
        {steps.map((x, i) => (
          <View
            key={x}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 4,
              backgroundColor: i <= step ? c.accent : c.card,
              borderColor: c.accent,
              borderWidth: i <= step ? 0 : 1,
            }}
          />
        ))}
      </Row>
      <Heading>
        {step === 0 ? "A little planning.\nA calmer tomorrow." : steps[step]}
      </Heading>
      <Body muted>
        {step === 0
          ? "Know when you’re working, when to rest, and what to get done before your next shift."
          : "Your routine is yours. Keep what fits, change what does not, and return to optional questions later."}
      </Body>
      <Card>
        {step === 0 ? (
          <View style={ui.stack}>
            <Heading small>Choose your starting point</Heading>
            <Button
              title="Early / late shift starter"
              secondary
              onPress={() => choose("starter")}
            />
            <Body muted>
              Starts with shift templates only. Travel and preparation stay
              unknown.
            </Body>
            <Button
              title="Start from scratch"
              secondary
              onPress={() => choose("scratch")}
            />
            <Body muted>
              Your answers save to your account as you go and stay editable in
              Settings.
            </Body>
          </View>
        ) : step < 5 ? (
          <SettingsFields state={state} change={change} section={step} />
        ) : (
          <View style={ui.stack}>
            <Heading small>Your setup, at a glance</Heading>
            <Body>
              {s.name ? s.name + " · " : ""}
              {s.timezone} · {s.clockFormat}-hour clock
            </Body>
            <Body>
              {previewEntries.length} rota entries recorded ·{" "}
              {state.templates.length} shift templates
            </Body>
            <Body>
              Outbound: {s.outboundMin ?? "?"}–{s.outboundMax ?? "?"} min ·
              Return: {s.returnMinutes ?? "Still needed"} min
            </Body>
            <Body>
              Sleep target:{" "}
              {s.sleepTarget === null
                ? "Still needed"
                : `${s.sleepTarget / 60} hours`}{" "}
              · Essential routines:{" "}
              {s.routines
                .map((r) => `${r.name}: ${r.minutes ?? "?"} min`)
                .join(", ") || "Still needed"}
            </Body>
            {p ? (
              <>
                <Heading small>Next-workday preview · {next?.duty}</Heading>
                {p.events.map((e) => (
                  <Row key={e.kind}>
                    <Pill text={displayTime(e.at, s.timezone, s.clockFormat)} />
                    <Body>{e.label}</Body>
                  </Row>
                ))}
                {p.missing.length > 0 && (
                  <Notice>Provisional: {p.missing.join("; ")}.</Notice>
                )}
                {p.conflicts.map((c) => (
                  <Notice error key={c}>
                    {c}
                  </Notice>
                ))}
              </>
            ) : (
              <Notice>Add your first duty in Rota to calculate a plan.</Notice>
            )}
            <Body muted>
              Reminders remain off until you choose to activate them. All of
              these answers stay editable in Settings.
            </Body>
            <Button
              title="Save setup & open Today"
              icon="check"
              onPress={() => {
                if (!s.timezoneConfirmed) {
                  notify("Confirm your work timezone in step 2 first.");
                  return;
                }
                change((a) => ({
                  ...a,
                  settings: {
                    ...a.settings,
                    onboardingComplete: true,
                    onboardingRotaPending: false,
                  },
                }));
              }}
            />
          </View>
        )}
      </Card>
      {step > 0 && (
        <Row style={{ justifyContent: "space-between" }}>
          <Button
            title="Back"
            secondary
            icon="arrow-left"
            onPress={() =>
              change((a) => ({
                ...a,
                settings: {
                  ...a.settings,
                  onboardingStep: Math.max(0, step - 1),
                },
              }))
            }
          />
          {step < 5 && (
            <Button
              title="Save & continue"
              icon="arrow-right"
              onPress={forward}
            />
          )}
        </Row>
      )}
    </View>
  );
}
