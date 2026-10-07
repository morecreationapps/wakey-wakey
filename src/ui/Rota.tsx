import React, { useState } from "react";
import { View, Pressable, Text } from "react-native";
import { Temporal } from "@js-temporal/polyfill";
import {
  RotaEntry,
  DayStatus,
  ShiftCategory,
  uid,
  systemClock,
  RepeatingPattern,
} from "../model";
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
  Toggle,
  Pill,
  Notice,
  Icon,
  ui,
} from "./components";
import { dateInZone, addDays, displayDate, zonedEpoch } from "../engine/time";
import {
  validateEntry,
  entryWarnings,
  scheduledMinutes,
  generatePattern,
  updatePattern,
  copyWeek,
  replaceEntry,
} from "../data/rota";
import {
  previewImport,
  importAccepted,
  exportCSV,
  exportICS,
} from "../data/import";
import { pickTextFile, exportTextFile } from "../platform/files";
export const statusLabel = (s: DayStatus) =>
  ({
    Work: "Work",
    Rest: "Rest",
    Holiday: "Annual leave",
    Sick: "Sick leave",
    OtherLeave: "Other leave",
    Unknown: "Unknown",
  })[s];
const categories: ShiftCategory[] = [
  "Early",
  "Middle",
  "Late",
  "Night",
  "Custom",
];
const statuses: DayStatus[] = [
  "Work",
  "Rest",
  "Holiday",
  "Sick",
  "OtherLeave",
  "Unknown",
];
function blank(date: string, tz: string): RotaEntry {
  return {
    id: uid("duty"),
    date,
    duty: "",
    category: "Early",
    status: "Work",
    start: date + "T06:00",
    end: date + "T14:18",
    timezone: tz,
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
  };
}
export function Rota({ state, change, notify }: ScreenProps) {
  const c = useTheme(),
    s = state.settings,
    today = dateInZone(systemClock, s.timezone);
  const [anchor, setAnchor] = useState(today),
    [view, setView] = useState<"Day" | "Week" | "Month" | "Year">("Month");
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [edit, setEdit] = useState<RotaEntry | null>(null),
    [review, setReview] = useState<string[]>([]),
    [removeReview, setRemoveReview] = useState(false);
  const [importText, setImportText] = useState(""),
    [showImport, setShowImport] = useState(false),
    [preview, setPreview] = useState<ReturnType<typeof previewImport> | null>(
      null,
    );
  const [tools, setTools] = useState(false),
    [templateName, setTemplateName] = useState(""),
    [templateDuty, setTemplateDuty] = useState(""),
    [templateStart, setTemplateStart] = useState("06:00"),
    [templateEnd, setTemplateEnd] = useState("14:18"),
    [templateCategory, setTemplateCategory] = useState<ShiftCategory>("Early");
  const [patternText, setPatternText] = useState(""),
    [patternStart, setPatternStart] = useState(today),
    [scope, setScope] = useState<"one" | "future" | "all">("future"),
    [copyTarget, setCopyTarget] = useState(addDays(today, 7));
  const day = Temporal.PlainDate.from(anchor),
    weekOffset = (day.dayOfWeek - (s.firstDay === "Monday" ? 1 : 7) + 7) % 7;
  const first =
    view === "Year"
      ? day.with({ month: 1, day: 1 })
      : view === "Month"
        ? day.with({ day: 1 })
        : view === "Week"
          ? day.subtract({ days: weekOffset })
          : day;
  const count =
    view === "Year"
      ? 12
      : view === "Month"
        ? first.daysInMonth
        : view === "Week"
          ? 7
          : 1;
  const dates = Array.from({ length: count }, (_, i) =>
    view === "Year"
      ? first.add({ months: i }).toString()
      : first.add({ days: i }).toString(),
  );
  const selected = state.entries.filter((e) => e.date === anchor);
  const shiftDays = (amount: number) =>
    setAnchor(
      view === "Year"
        ? day.add({ years: amount }).toString()
        : view === "Month"
          ? day.add({ months: amount }).toString()
          : addDays(anchor, amount * (view === "Week" ? 7 : 1)),
    );
  const put = (patch: Partial<RotaEntry>) => {
    setEdit((e) => (e ? { ...e, ...patch } : null));
    setReview([]);
  };
  function save(allow = false) {
    if (!edit) return;
    try {
      if (edit.status === "Work") {
        if (!edit.start || !edit.end)
          throw Error("Work start and finish are needed.");
        zonedEpoch(edit.start, edit.timezone, edit.disambiguation);
        zonedEpoch(edit.end, edit.timezone, edit.disambiguation);
      }
      const entry =
        edit.status === "Work"
          ? edit
          : {
              ...edit,
              start: null,
              end: null,
              actualEnd: null,
              overtimeMinutes: 0,
            };
      const errors = validateEntry(entry, state.entries, entry.id);
      if (errors.length) {
        setReview(errors);
        return;
      }
      if (
        errors.some((x) =>
          /invalid|must be|non-existent|ambiguous|positive|timezone|earlier than|finish.*start/i.test(
            x,
          ),
        )
      ) {
        setReview(errors);
        return;
      }
      change((a) => ({ ...a, entries: replaceEntry(a.entries, entry) }));
      setEdit(null);
      notify("Rota entry saved. Plans and reminders are being refreshed.");
    } catch (e) {
      setReview([String((e as Error).message)]);
    }
  }
  function doPattern(id?: string) {
    try {
      const days = patternText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
          const template = state.templates.find(
            (x) =>
              x.id === t ||
              x.name.toLowerCase() === t.toLowerCase() ||
              x.category.toLowerCase() === t.toLowerCase(),
          );
          if (template)
            return { status: "Work" as const, templateId: template.id };
          const st = statuses.find((x) => x.toLowerCase() === t.toLowerCase());
          if (st && st !== "Work") return { status: st };
          throw Error(`Unknown pattern item: ${t}`);
        });
      if (!days.length)
        throw Error("Enter a pattern using template names and Rest.");
      if (days.length > 366)
        throw Error("A pattern can contain at most 366 days.");
      const pattern: RepeatingPattern = {
        id: id ?? uid("pattern"),
        name: "My repeating pattern",
        startDate: patternStart,
        until: addDays(patternStart, 364),
        days,
      };
      const result = id
        ? updatePattern(
            pattern,
            state.templates,
            state.entries,
            scope,
            anchor,
            s.timezone,
          )
        : generatePattern(pattern, state.templates, state.entries, s.timezone);
      change((a) => ({
        ...a,
        entries: result.entries,
        patterns: [...a.patterns.filter((x) => x.id !== pattern.id), pattern],
      }));
      notify(
        result.warnings.length
          ? result.warnings.join(" · ")
          : "Pattern generated through " +
              displayDate(pattern.until, s.dateFormat) +
              ". Individual exceptions are preserved.",
      );
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <View style={ui.stack}>
      <Row style={{ justifyContent: "space-between" }}>
        <View>
          <Heading>Your rota</Heading>
          <Body muted>Work, rest and everything in between.</Body>
        </View>
        <Button
          title="Add duty / leave"
          icon="plus"
          onPress={() => {
            setEdit(blank(anchor, s.timezone));
            setReview([]);
            setRemoveReview(false);
          }}
        />
      </Row>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Choices
            values={["Day", "Week", "Month", "Year"]}
            value={view}
            onChange={setView}
          />
          <Row>
            <Button
              title="Previous"
              secondary
              small
              icon="chevron-left"
              onPress={() => shiftDays(-1)}
            />
            <Button
              title="Today"
              secondary
              small
              onPress={() => setAnchor(today)}
            />
            <Button
              title="Next"
              secondary
              small
              icon="chevron-right"
              onPress={() => shiftDays(1)}
            />
          </Row>
        </Row>
        <Row>
          <Heading small>
            {view === "Year"
              ? String(day.year)
              : new Intl.DateTimeFormat("en-GB", {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }).format(new Date(anchor + "T12:00:00Z"))}
          </Heading>
          <Pill text={s.timezone} />
        </Row>
        {view === "Month" && (
          <Row>
            {(s.firstDay === "Monday"
              ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
              : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            ).map((x) => (
              <Text
                key={x}
                style={{
                  width: "12.9%",
                  textAlign: "center",
                  fontSize: 11,
                  color: c.muted,
                }}
              >
                {x}
              </Text>
            ))}
          </Row>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {view === "Month" &&
            Array.from(
              {
                length:
                  (first.dayOfWeek - (s.firstDay === "Monday" ? 1 : 7) + 7) % 7,
              },
              (_, i) => <View key={"empty" + i} style={{ width: "13.3%" }} />,
            )}
          {dates.map((date) => {
            const list = state.entries.filter((e) =>
              view === "Year"
                ? e.date.startsWith(date.slice(0, 7))
                : e.date === date,
            );
            const entry = list[0];
            return (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityState={{ selected: date === anchor }}
                accessibilityLabel={`${displayDate(date, s.dateFormat)} ${entry ? statusLabel(entry.status) + " " + entry.duty : "Unknown"}`}
                onFocus={() => setFocusedDate(date)}
                onBlur={() => setFocusedDate(null)}
                onPress={() => {
                  setAnchor(date);
                  if (view === "Year") setView("Month");
                }}
                style={({ pressed }) => ({
                  width:
                    view === "Year"
                      ? "31.5%"
                      : view === "Day"
                        ? "100%"
                        : "13.3%",
                  minHeight: view === "Year" ? 85 : 78,
                  backgroundColor: c.accent,
                  borderWidth: 1,
                  borderColor:
                    date === anchor || pressed ? c.onAccent : c.accent,
                  borderRadius: 12,
                  padding: 8,
                  gap: 5,
                  outlineColor: c.onAccent,
                  outlineWidth: focusedDate === date || pressed ? 2 : 0,
                  outlineStyle: "solid",
                  outlineOffset: -4,
                  transform: [{ translateY: pressed ? 1 : 0 }],
                })}
              >
                <Text
                  style={{
                    color: c.onAccent,
                    fontSize: 14,
                    fontWeight: date === anchor ? "700" : "500",
                    textDecorationLine: date === anchor ? "underline" : "none",
                  }}
                >
                  {view === "Year"
                    ? new Intl.DateTimeFormat("en-GB", {
                        month: "short",
                        timeZone: "UTC",
                      }).format(new Date(date + "T12:00:00Z"))
                    : Temporal.PlainDate.from(date).day}
                </Text>
                <Text
                  numberOfLines={2}
                  style={{
                    color: c.onAccent,
                    fontSize: 10,
                    fontWeight: "600",
                  }}
                >
                  {view === "Year"
                    ? `${list.filter((e) => e.status === "Work").length} duties`
                    : entry?.status === "Work"
                      ? `${entry.category[0]} · ${entry.duty || "Work"}`
                      : entry
                        ? entry.status === "Holiday"
                          ? entry.leaveApproval !== "confirmed"
                            ? "Leave?"
                            : "Leave"
                          : statusLabel(entry.status)
                        : "—"}
                </Text>
                {list.length > 1 && view !== "Year" && (
                  <Text style={{ fontSize: 9, color: c.onAccent }}>
                    +{list.length - 1} more
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
        <Row>
          <Pill text="E · Early" tone="sun" />
          <Pill text="L · Late" tone="night" />
          <Pill text="Rest · confirmed" />
          <Body muted style={{ fontSize: 11 }}>
            — Unfilled / Unknown
          </Body>
        </Row>
        <Body muted style={{ fontSize: 12 }}>
          Plan at least 52 weeks ahead. Past entries stay saved. Scheduled hours
          and paid hours are separate.
        </Body>
      </Card>
      <Heading small>{displayDate(anchor, s.dateFormat)}</Heading>
      {selected.length === 0 ? (
        <Card>
          <Body>
            No rota recorded. This is an unknown day, not a confirmed rest day.
          </Body>
          <Button
            title="Record this day"
            secondary
            onPress={() => {
              setEdit(blank(anchor, s.timezone));
              setRemoveReview(false);
            }}
          />
        </Card>
      ) : (
        selected.map((e) => (
          <Card key={e.id}>
            <Row style={{ justifyContent: "space-between" }}>
              <View style={{ gap: 7 }}>
                <Pill
                  text={
                    e.status === "Work" ? e.category : statusLabel(e.status)
                  }
                  tone={e.category === "Late" ? "night" : "soft"}
                />
                <Heading small>
                  {e.duty ||
                    (e.status === "Work"
                      ? "Unnamed duty"
                      : statusLabel(e.status))}
                </Heading>
              </View>
              <Button
                title="Edit"
                secondary
                small
                icon="edit-2"
                onPress={() => {
                  setEdit({ ...e });
                  setReview([]);
                  setRemoveReview(false);
                }}
              />
            </Row>
            <Body>
              {e.start?.replace("T", " ")}{" "}
              {e.end ? " → " + e.end.replace("T", " ") : ""}
            </Body>
            {e.status === "Holiday" && (
              <Notice>
                {e.leaveApproval !== "confirmed"
                  ? "Requested annual leave — not approved. Keep confirmed duties recorded until approval."
                  : "Confirmed annual leave."}
              </Notice>
            )}
            {e.status === "Work" && (
              <Body muted>
                Scheduled:{" "}
                {scheduledMinutes(e) === null
                  ? "Unknown"
                  : `${(scheduledMinutes(e)! / 60).toFixed(2)} h`}{" "}
                · Paid:{" "}
                {e.paidMinutes === null
                  ? "Unknown"
                  : (e.paidMinutes / 60).toFixed(2) + " h"}
                {e.overtimeMinutes > 0
                  ? ` · Overtime extension: ${e.overtimeMinutes} min`
                  : ""}
                {e.actualEnd
                  ? ` · Actual finish: ${e.actualEnd.replace("T", " ")}`
                  : ""}
              </Body>
            )}
            {e.exception && <Pill text="Individual pattern exception" />}
            {!!e.notes && <Body muted>{e.notes}</Body>}
          </Card>
        ))
      )}
      {edit && (
        <Card>
          <Heading small>
            {state.entries.some((e) => e.id === edit.id)
              ? "Edit entry"
              : "New rota entry"}
          </Heading>
          <Field
            label="Date (YYYY-MM-DD)"
            value={edit.date}
            onChange={(v) =>
              put({
                date: v,
                start: edit.start ? v + "T" + edit.start.split("T")[1] : null,
                end: edit.end ? v + "T" + edit.end.split("T")[1] : null,
              })
            }
          />
          <Choices
            values={statuses}
            value={edit.status}
            onChange={(v) =>
              put({
                status: v,
                leaveApproval: v === "Holiday" ? "requested" : undefined,
              })
            }
          />
          {edit.status === "Holiday" && (
            <Choices
              values={["requested", "confirmed"]}
              value={edit.leaveApproval ?? "requested"}
              onChange={(v) => put({ leaveApproval: v })}
            />
          )}
          <Field
            label="Duty code / name (text)"
            value={edit.duty}
            onChange={(v) => put({ duty: v })}
            placeholder="Leading zeroes are preserved"
          />
          {edit.status === "Work" && (
            <>
              <Choices
                values={categories}
                value={edit.category}
                onChange={(v) => put({ category: v })}
              />
              <Row>
                {state.templates.map((t) => (
                  <Button
                    key={t.id}
                    title={t.name}
                    secondary
                    small
                    onPress={() =>
                      put({
                        duty: t.duty,
                        category: t.category,
                        start: edit.date + "T" + t.start,
                        end:
                          (t.end <= t.start
                            ? addDays(edit.date, 1)
                            : edit.date) +
                          "T" +
                          t.end,
                      })
                    }
                  />
                ))}
              </Row>
              <Row>
                <Field
                  label="Start (YYYY-MM-DDTHH:mm)"
                  value={edit.start ?? ""}
                  onChange={(v) => put({ start: v })}
                />
                <Field
                  label="Finish (YYYY-MM-DDTHH:mm)"
                  value={edit.end ?? ""}
                  onChange={(v) => put({ end: v })}
                />
              </Row>
              <Body muted>
                For an overnight duty, use the next calendar date for its
                finish.
              </Body>
              <Field
                label="Actual finish (optional)"
                value={edit.actualEnd ?? ""}
                onChange={(v) => put({ actualEnd: v || null })}
              />
              <Row>
                <Field
                  label="Overtime extension (minutes)"
                  value={String(edit.overtimeMinutes)}
                  numeric
                  onChange={(v) =>
                    /^\d*$/.test(v) && put({ overtimeMinutes: Number(v) })
                  }
                />
                <Field
                  label="Break minutes (optional)"
                  value={
                    edit.breakMinutes === null ? "" : String(edit.breakMinutes)
                  }
                  numeric
                  onChange={(v) =>
                    /^\d*$/.test(v) &&
                    put({ breakMinutes: v === "" ? null : Number(v) })
                  }
                />
                <Field
                  label="Explicit paid minutes (optional)"
                  value={
                    edit.paidMinutes === null ? "" : String(edit.paidMinutes)
                  }
                  numeric
                  onChange={(v) =>
                    /^\d*$/.test(v) &&
                    put({ paidMinutes: v === "" ? null : Number(v) })
                  }
                />
              </Row>
              <Body muted>
                Overtime extends this duty once. A separate overtime duty is a
                separate work period.
              </Body>
              <Body muted>
                DST duplicate local times: choose an occurrence only if
                applicable.
              </Body>
              <Choices
                values={["reject", "earlier", "later"]}
                value={edit.disambiguation ?? "reject"}
                onChange={(v) =>
                  put({ disambiguation: v === "reject" ? undefined : v })
                }
              />
            </>
          )}
          <Field
            label="Location (optional)"
            value={edit.location}
            onChange={(v) => put({ location: v })}
          />
          <Field
            label="Private notes (optional)"
            value={edit.notes}
            onChange={(v) => put({ notes: v })}
          />
          {entryWarnings(edit).map((r) => (
            <Notice key={r}>{r}</Notice>
          ))}
          {review.map((r) => (
            <Notice error key={r}>
              {r}
            </Notice>
          ))}
          <Row>
            <Button
              title={review.length ? "Recheck & save entry" : "Save entry"}
              onPress={() => save(review.length > 0)}
            />
            <Button title="Cancel" secondary onPress={() => setEdit(null)} />
            {state.entries.some((e) => e.id === edit.id) && (
              <Button
                title={removeReview ? "Confirm delete entry" : "Delete entry"}
                danger
                onPress={() => {
                  if (!removeReview) {
                    setRemoveReview(true);
                    return;
                  }
                  change((a) => ({
                    ...a,
                    entries: edit.patternId
                      ? a.entries.map((e) =>
                          e.id === edit.id
                            ? {
                                ...e,
                                status: "Unknown",
                                start: null,
                                end: null,
                                actualEnd: null,
                                overtimeMinutes: 0,
                                duty: "",
                                leaveApproval: undefined,
                                exception: true,
                              }
                            : e,
                        )
                      : a.entries.filter((e) => e.id !== edit.id),
                  }));
                  setEdit(null);
                  notify("Entry deleted. Undo is available.");
                }}
              />
            )}
          </Row>
        </Card>
      )}
      <Row>
        <Button
          title="Import rota"
          secondary
          icon="upload"
          onPress={() => setShowImport(!showImport)}
        />
        <Button
          title="Templates & patterns"
          secondary
          icon="repeat"
          onPress={() => setTools(!tools)}
        />
        <Button
          title="Export CSV"
          secondary
          icon="download"
          onPress={() =>
            exportTextFile(
              "wakey-rota.csv",
              exportCSV(state.entries),
              "text/csv",
            ).catch((e) => notify(e.message))
          }
        />
        <Button
          title="Export work calendar"
          secondary
          icon="calendar"
          onPress={() =>
            exportTextFile(
              "wakey-rota.ics",
              exportICS(state.entries.filter((e) => e.status === "Work")),
              "text/calendar",
            ).catch((e) => notify(e.message))
          }
        />
      </Row>
      {showImport && (
        <Card>
          <Heading small>Review before saving</Heading>
          <Body muted>
            CSV uses ISO dates. Pasted rota text supports explicit UK dates.
            Imports never overwrite existing entries. Photo/PDF recognition is
            deferred; transcribe the image into this preview or upload a
            text/CSV file.
          </Body>
          <Button
            title="Choose CSV / text file"
            secondary
            icon="file"
            onPress={async () => {
              try {
                const f = await pickTextFile();
                if (f) {
                  setImportText(f.text);
                  setPreview(previewImport(f.text, s.timezone, state.entries));
                }
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          />
          <Field
            label="CSV or pasted rota"
            value={importText}
            onChange={(v) => {
              setImportText(v);
              setPreview(null);
            }}
            multiline
            placeholder="date,duty,shift_type,start_time,end_time,end_date,status,overtime_minutes,notes"
          />
          <Button
            title="Preview import"
            onPress={() =>
              setPreview(previewImport(importText, s.timezone, state.entries))
            }
          />
          {preview && (
            <>
              <Body>
                {preview.rows.length} rows ·{" "}
                {preview.rows.filter((r) => r.duplicate).length} duplicates
              </Body>
              {preview.errors.map((e) => (
                <Notice error key={e}>
                  {e}
                </Notice>
              ))}
              {preview.rows.map((r) => (
                <View
                  key={r.line}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderColor: c.line,
                  }}
                >
                  <Body>
                    {r.entry
                      ? `${displayDate(r.entry.date, s.dateFormat)} · ${r.entry.duty || r.entry.status} · ${r.entry.start?.split("T")[1] ?? ""}`
                      : `Row ${r.line}`}
                    {r.duplicate ? " · Duplicate, will skip" : ""}
                  </Body>
                  {r.errors.map((e) => (
                    <Body key={e} style={{ color: c.red, fontSize: 12 }}>
                      <Icon name="alert-circle" size={12} /> Error: {e}
                    </Body>
                  ))}
                  {r.warnings.map((e) => (
                    <Body key={e} style={{ color: c.warn, fontSize: 12 }}>
                      <Icon name="alert-triangle" size={12} /> Warning: {e}
                    </Body>
                  ))}
                </View>
              ))}
              <Button
                title="Confirm valid rows"
                disabled={preview.rows.every(
                  (r) => !r.entry || r.errors.length > 0 || r.duplicate,
                )}
                onPress={() => {
                  change((a) => ({
                    ...a,
                    entries: importAccepted(preview, a.entries),
                  }));
                  setPreview(null);
                  setShowImport(false);
                  notify(
                    "Valid reviewed entries imported. Conflicting rows were skipped.",
                  );
                }}
              />
            </>
          )}
        </Card>
      )}
      {tools && (
        <>
          <Card>
            <Heading small>Reusable shift templates</Heading>
            {state.templates.map((t) => (
              <Row key={t.id} style={{ justifyContent: "space-between" }}>
                <Body>
                  {t.name} · {t.duty} · {t.start}–{t.end}
                </Body>
                <Button
                  title="Edit template"
                  secondary
                  small
                  onPress={() => {
                    setTemplateName(t.name);
                    setTemplateDuty(t.duty);
                    setTemplateCategory(t.category);
                    setTemplateStart(t.start);
                    setTemplateEnd(t.end);
                  }}
                />
              </Row>
            ))}
            <Row>
              <Field
                label="Template name"
                value={templateName}
                onChange={setTemplateName}
              />
              <Field
                label="Template duty"
                value={templateDuty}
                onChange={setTemplateDuty}
              />
            </Row>
            <Choices
              values={categories}
              value={templateCategory}
              onChange={setTemplateCategory}
            />
            <Row>
              <Field
                label="Template start HH:mm"
                value={templateStart}
                onChange={setTemplateStart}
              />
              <Field
                label="Template finish HH:mm"
                value={templateEnd}
                onChange={setTemplateEnd}
              />
            </Row>
            <Button
              title="Save template"
              onPress={() => {
                if (
                  !templateName.trim() ||
                  ![templateStart, templateEnd].every((t) =>
                    /^([01]\d|2[0-3]):[0-5]\d$/.test(t),
                  )
                ) {
                  notify("Give the template a name and valid HH:mm times.");
                  return;
                }
                change((a) => ({
                  ...a,
                  templates: [
                    ...a.templates.filter((t) => t.name !== templateName),
                    {
                      id:
                        a.templates.find((t) => t.name === templateName)?.id ??
                        uid("template"),
                      name: templateName,
                      duty: templateDuty,
                      category: templateCategory,
                      start: templateStart,
                      end: templateEnd,
                    },
                  ],
                }));
                notify(
                  "Template saved. Existing duties retain their recorded times.",
                );
              }}
            />
          </Card>
          <Card>
            <Heading small>Your actual repeating pattern</Heading>
            <Body muted>
              Use a sequence of template names and statuses. Any custom length
              is allowed; no rotation is assumed. Existing manual duties and
              individual exceptions are preserved.
            </Body>
            <Field
              label="Pattern starts YYYY-MM-DD"
              value={patternStart}
              onChange={setPatternStart}
            />
            <Field
              label="Pattern sequence (comma separated)"
              value={patternText}
              onChange={setPatternText}
              placeholder="Early shift, Early shift, Rest, Late shift, Rest"
            />
            <Button
              title="Generate 52 weeks"
              icon="repeat"
              onPress={() => doPattern()}
            />
            {state.patterns.map((p) => (
              <View key={p.id} style={ui.section}>
                <Body>
                  {p.name} · {p.days.length}-day pattern
                </Body>
                <Choices
                  values={["one", "future", "all"]}
                  value={scope}
                  onChange={setScope}
                />
                <Button
                  title="Apply entered pattern to selected scope"
                  secondary
                  onPress={() => doPattern(p.id)}
                />
              </View>
            ))}
          </Card>
          <Card>
            <Heading small>Copy a week</Heading>
            <Body muted>
              Copies seven days from the selected date,{" "}
              {displayDate(anchor, s.dateFormat)}. Existing target entries are
              retained.
            </Body>
            <Field
              label="Target week start YYYY-MM-DD"
              value={copyTarget}
              onChange={setCopyTarget}
            />
            <Button
              title="Copy & review conflicts"
              secondary
              onPress={() => {
                try {
                  const r = copyWeek(state.entries, anchor, copyTarget);
                  change((a) => ({ ...a, entries: r.entries }));
                  notify(
                    r.conflicts.length
                      ? r.conflicts.flatMap((x) => x.errors).join(" · ")
                      : "Week copied without replacing existing entries.",
                  );
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            />
          </Card>
        </>
      )}
    </View>
  );
}
