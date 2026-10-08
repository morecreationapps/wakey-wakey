import { Temporal } from "@js-temporal/polyfill";
import { AppState, RotaEntry } from "../model";
import {
  CATEGORIES,
  STATUSES,
  validateEntry,
  validDate,
  validLocal,
  validTime,
  validTimezone,
} from "./rota";

type Obj = Record<string, unknown>;
function fail(path: string, reason: string): never {
  throw new Error(
    `Invalid backup: ${path} ${reason}. Your existing data has not been changed.`,
  );
}
function object(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  const record = value as Obj;
  if (
    Object.keys(record).some((key) =>
      ["__proto__", "prototype", "constructor"].includes(key),
    )
  )
    fail(path, "contains a forbidden structural key");
  return record;
}
function array(value: unknown, path: string, maximum = 30000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    fail(path, `must be an array with at most ${maximum} items`);
  return value;
}
function string(value: unknown, path: string, maximum = 10000): string {
  if (typeof value !== "string" || value.length > maximum)
    fail(path, `must be text with at most ${maximum} characters`);
  return value;
}
function bool(value: unknown, path: string): void {
  if (typeof value !== "boolean") fail(path, "must be true or false");
}
function number(
  value: unknown,
  path: string,
  maximum = 2880,
  nullable = false,
  minimum = 0,
): void {
  if (nullable && value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    fail(
      path,
      `must be ${nullable ? "null or " : ""}a number between ${minimum} and ${maximum}`,
    );
}
function choice(
  value: unknown,
  choices: readonly string[],
  path: string,
): void {
  if (typeof value !== "string" || !choices.includes(value))
    fail(path, `must be one of ${choices.join(", ")}`);
}
function date(value: unknown, path: string): void {
  if (!validDate(string(value, path))) fail(path, "must be a real ISO date");
}
function local(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return;
  if (!validLocal(string(value, path)))
    fail(path, "must be a valid local date/time");
}
function time(value: unknown, path: string, nullable = false): void {
  if (nullable && value === null) return;
  if (!validTime(string(value, path))) fail(path, "must be a valid HH:mm time");
}
function id(value: unknown, path: string): string {
  const result = string(value, path, 300);
  if (!result.trim() || /[\r\n]/.test(result))
    fail(path, "must be a non-empty identifier without newlines");
  return result;
}
function ids(items: unknown[], path: string): void {
  const seen = new Set<string>();
  items.forEach((value, index) => {
    const itemId = id(
      object(value, `${path}[${index}]`).id,
      `${path}[${index}].id`,
    );
    if (seen.has(itemId)) fail(path, "contains repeated identifiers");
    seen.add(itemId);
  });
}
/** Schema validation only: imported strings remain data, including notes that look like prompts. */
export function validateBackup(value: unknown): AppState {
  const state = object(value, "root");
  if (state.schemaVersion !== 1)
    fail(
      "schemaVersion",
      "must be 1; this version cannot restore another schema",
    );
  for (const key of Object.keys(state))
    if (
      ![
        "schemaVersion",
        "settings",
        "entries",
        "templates",
        "patterns",
        "tasks",
        "sleepLogs",
      ].includes(key)
    )
      fail(`root.${key}`, "is not a schema 1 field");
  const settings = object(state.settings, "settings");
  for (const key of ["name", "role", "travelMode"])
    string(settings[key], `settings.${key}`, 1000);
  const timezone = string(settings.timezone, "settings.timezone", 200);
  if (!validTimezone(timezone))
    fail("settings.timezone", "must be a valid timezone");
  for (const key of [
    "safetyCritical",
    "timezoneConfirmed",
    "additionalPrepConfirmed",
    "consistentWake",
    "caffeine",
    "remindersEnabled",
    "onboardingComplete",
  ])
    bool(settings[key], `settings.${key}`);
  if (settings.onboardingRotaPending !== undefined)
    bool(settings.onboardingRotaPending, "settings.onboardingRotaPending");
  if (settings.caffeineBeforeBed !== undefined)
    number(settings.caffeineBeforeBed, "settings.caffeineBeforeBed", 2880);
  choice(
    settings.dateFormat,
    ["UK", "ISO", "LONG", "LONG_ISO"],
    "settings.dateFormat",
  );
  choice(settings.clockFormat, ["24", "12"], "settings.clockFormat");
  choice(
    settings.firstDay,
    ["Monday", "Sunday", "Saturday"],
    "settings.firstDay",
  );
  choice(settings.theme, ["light", "dark", "system"], "settings.theme");
  for (const key of [
    "outboundMin",
    "outboundMax",
    "returnMinutes",
    "arrivalBuffer",
    "sleepTarget",
    "latency",
    "windDown",
    "postWorkMinutes",
  ])
    number(settings[key], `settings.${key}`, 2880, true);
  if (
    typeof settings.outboundMin === "number" &&
    typeof settings.outboundMax === "number" &&
    settings.outboundMin > settings.outboundMax
  )
    fail("settings.outboundMin", "cannot exceed outboundMax");
  number(settings.freeMinutes, "settings.freeMinutes", 1440);
  number(settings.onboardingStep, "settings.onboardingStep", 20);
  if (!Number.isInteger(settings.onboardingStep))
    fail("settings.onboardingStep", "must be a whole number");
  for (const key of [
    "earlyBed",
    "earlyWake",
    "lateBed",
    "lateWake",
    "restBed",
    "restWake",
  ])
    time(settings[key], `settings.${key}`, true);
  array(settings.reminderKinds, "settings.reminderKinds", 20).forEach(
    (item, index) =>
      choice(
        item,
        [
          "prepare",
          "windDown",
          "bedtime",
          "wake",
          "departure",
          "appointment",
          "transition",
          "caffeine",
        ],
        `settings.reminderKinds[${index}]`,
      ),
  );
  const origins = object(settings.origins, "settings.origins");
  for (const key of Object.keys(origins)) {
    string(key, "settings.origins key", 200);
    choice(
      origins[key],
      ["entered", "suggested", "needed"],
      `settings.origins.${key}`,
    );
  }
  const routines = array(settings.routines, "settings.routines", 200);
  ids(routines, "settings.routines");
  routines.forEach((value, index) => {
    const path = `settings.routines[${index}]`,
      item = object(value, path);
    string(item.name, `${path}.name`, 1000);
    number(item.minutes, `${path}.minutes`, 1440, true);
    bool(item.essential, `${path}.essential`);
    array(item.includes, `${path}.includes`, 100).forEach((text, at) =>
      string(text, `${path}.includes[${at}]`, 300),
    );
  });
  const entries = array(state.entries, "entries");
  ids(entries, "entries");
  entries.forEach((value, index) => {
    const path = `entries[${index}]`,
      item = object(value, path);
    date(item.date, `${path}.date`);
    string(item.duty, `${path}.duty`, 1000);
    choice(item.category, CATEGORIES, `${path}.category`);
    choice(item.status, STATUSES, `${path}.status`);
    local(item.start, `${path}.start`, true);
    local(item.end, `${path}.end`, true);
    if (item.actualEnd !== undefined)
      local(item.actualEnd, `${path}.actualEnd`, true);
    string(item.timezone, `${path}.timezone`, 200);
    string(item.location, `${path}.location`, 2000);
    string(item.notes, `${path}.notes`, 20000);
    number(item.overtimeMinutes, `${path}.overtimeMinutes`);
    number(item.breakMinutes, `${path}.breakMinutes`, 2880, true);
    number(item.paidMinutes, `${path}.paidMinutes`, 2880, true);
    if (item.disambiguation !== undefined)
      choice(
        item.disambiguation,
        ["earlier", "later"],
        `${path}.disambiguation`,
      );
    if (item.leaveApproval !== undefined)
      choice(
        item.leaveApproval,
        ["requested", "confirmed"],
        `${path}.leaveApproval`,
      );
    if (item.patternId !== undefined) id(item.patternId, `${path}.patternId`);
    if (item.exception !== undefined) bool(item.exception, `${path}.exception`);
    const errors = validateEntry(item as unknown as RotaEntry);
    if (errors.length) fail(path, errors.join(" "));
  });
  const templates = array(state.templates, "templates", 1000);
  ids(templates, "templates");
  templates.forEach((value, index) => {
    const path = `templates[${index}]`,
      item = object(value, path);
    string(item.name, `${path}.name`, 1000);
    string(item.duty, `${path}.duty`, 1000);
    choice(item.category, CATEGORIES, `${path}.category`);
    time(item.start, `${path}.start`);
    time(item.end, `${path}.end`);
  });
  const patterns = array(state.patterns, "patterns", 1000);
  ids(patterns, "patterns");
  patterns.forEach((value, index) => {
    const path = `patterns[${index}]`,
      item = object(value, path);
    string(item.name, `${path}.name`, 1000);
    date(item.startDate, `${path}.startDate`);
    date(item.until, `${path}.until`);
    if ((item.until as string) < (item.startDate as string))
      fail(path, "ends before it starts");
    const days = array(item.days, `${path}.days`, 366);
    if (!days.length) fail(`${path}.days`, "must contain at least one day");
    days.forEach((value, at) => {
      const day = object(value, `${path}.days[${at}]`);
      choice(day.status, STATUSES, `${path}.days[${at}].status`);
      if (day.status === "Work" || day.templateId !== undefined) {
        id(day.templateId, `${path}.days[${at}].templateId`);
        if (
          !templates.some((template) => (template as Obj).id === day.templateId)
        )
          fail(
            `${path}.days[${at}].templateId`,
            "does not reference an existing template",
          );
      }
    });
  });
  const tasks = array(state.tasks, "tasks", 10000);
  ids(tasks, "tasks");
  tasks.forEach((value, index) => {
    const path = `tasks[${index}]`,
      item = object(value, path);
    string(item.title, `${path}.title`, 2000);
    string(item.location, `${path}.location`, 2000);
    choice(
      item.kind,
      ["fixed", "essential", "flexible", "optional"],
      `${path}.kind`,
    );
    choice(item.recurrence, ["none", "daily", "weekly"], `${path}.recurrence`);
    choice(
      item.state,
      ["pending", "accepted", "completed", "skipped", "deferred"],
      `${path}.state`,
    );
    number(item.minutes, `${path}.minutes`, 1440, false, 1);
    number(item.travelMinutes, `${path}.travelMinutes`, 1440);
    number(item.priority, `${path}.priority`, 1000);
    local(item.deadline, `${path}.deadline`);
    local(item.earliest, `${path}.earliest`);
    local(item.scheduledStart, `${path}.scheduledStart`, true);
    time(item.windowStart, `${path}.windowStart`);
    time(item.windowEnd, `${path}.windowEnd`);
    for (const key of ["movable", "splittable", "locked"])
      bool(item[key], `${path}.${key}`);
    if (item.linkedShiftId !== undefined)
      id(item.linkedShiftId, `${path}.linkedShiftId`);
    if (item.occurrenceStates !== undefined) {
      const occurrences = object(
        item.occurrenceStates,
        `${path}.occurrenceStates`,
      );
      if (Object.keys(occurrences).length > 30000)
        fail(
          `${path}.occurrenceStates`,
          "contains more than 30000 occurrences",
        );
      for (const occurrenceDate of Object.keys(occurrences)) {
        date(occurrenceDate, `${path}.occurrenceStates key`);
        choice(
          occurrences[occurrenceDate],
          ["pending", "accepted", "completed", "skipped", "deferred"],
          `${path}.occurrenceStates.${occurrenceDate}`,
        );
      }
    }
    if (
      Temporal.PlainDateTime.compare(
        Temporal.PlainDateTime.from(item.deadline as string),
        Temporal.PlainDateTime.from(item.earliest as string),
      ) < 0
    )
      fail(path, "has a deadline before its earliest time");
  });
  const sleepLogs = array(state.sleepLogs, "sleepLogs");
  ids(sleepLogs, "sleepLogs");
  sleepLogs.forEach((value, index) => {
    const path = `sleepLogs[${index}]`,
      item = object(value, path);
    date(item.date, `${path}.date`);
    local(item.bedtime, `${path}.bedtime`);
    local(item.wake, `${path}.wake`);
    number(item.estimatedMinutes, `${path}.estimatedMinutes`, 1440, true);
    number(item.awakenings, `${path}.awakenings`, 100, true);
    string(item.rested, `${path}.rested`, 1000);
    if (
      Temporal.PlainDateTime.compare(
        Temporal.PlainDateTime.from(item.wake as string),
        Temporal.PlainDateTime.from(item.bedtime as string),
      ) <= 0
    )
      fail(path, "must wake after bedtime");
  });
  // Return a JSON copy, never the caller's object/prototype. Every field used by the app has been checked.
  return JSON.parse(JSON.stringify(state)) as AppState;
}
export function parseBackup(text: string): AppState {
  if (text.length > 10_000_000)
    throw new Error(
      "Backup exceeds the 10 MB restore limit. Existing data has not been changed.",
    );
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      "This is not a valid JSON backup. Existing data has not been changed.",
    );
  }
  return validateBackup(value);
}
export function exportBackup(state: AppState): string {
  return JSON.stringify(validateBackup(state), null, 2);
}
