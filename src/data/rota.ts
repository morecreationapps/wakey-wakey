import { Temporal } from "@js-temporal/polyfill";
import {
  RotaEntry,
  RepeatingPattern,
  ShiftTemplate,
  DayStatus,
  ShiftCategory,
  uid,
} from "../model";

export const STATUSES: DayStatus[] = [
  "Work",
  "Rest",
  "Holiday",
  "Sick",
  "OtherLeave",
  "Unknown",
];
export const CATEGORIES: ShiftCategory[] = [
  "Early",
  "Middle",
  "Late",
  "Night",
  "Custom",
];
export function validDate(value: string): boolean {
  try {
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Temporal.PlainDate.from(value).toString() === value
    );
  } catch {
    return false;
  }
}
export function validTime(value: string): boolean {
  try {
    return (
      /^\d{2}:\d{2}$/.test(value) &&
      Temporal.PlainTime.from(value).toString({ smallestUnit: "minute" }) ===
        value
    );
  } catch {
    return false;
  }
}
export function validLocal(value: string): boolean {
  try {
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) &&
      !!Temporal.PlainDateTime.from(value)
    );
  } catch {
    return false;
  }
}
export function validTimezone(value: string): boolean {
  try {
    new Temporal.ZonedDateTime(0n, value);
    return !!value;
  } catch {
    return false;
  }
}
/** Reject gaps; repeated local times need an explicit earlier/later selection. */
export function entryInstant(
  local: string,
  timezone: string,
  disambiguation?: "earlier" | "later",
): number {
  const plain = Temporal.PlainDateTime.from(local);
  const zoned = plain.toZonedDateTime(timezone, {
    disambiguation: disambiguation ?? "reject",
  });
  if (!zoned.toPlainDateTime().equals(plain))
    throw new Error(
      "This local time does not exist during the daylight-saving change. Choose a real time.",
    );
  return zoned.epochMilliseconds;
}
export function scheduledMinutes(entry: RotaEntry): number | null {
  if (entry.status !== "Work") return 0;
  if (!entry.start || !entry.end) return null;
  try {
    return (
      (entryInstant(entry.end, entry.timezone, entry.disambiguation) -
        entryInstant(entry.start, entry.timezone, entry.disambiguation)) /
        60000 +
      entry.overtimeMinutes
    );
  } catch {
    return null;
  }
}
/** Actual finish replaces the extended planned finish; overtime is never added twice. */
export function effectiveEnd(entry: RotaEntry): number | null {
  if (!entry.end || entry.status !== "Work") return null;
  try {
    return entry.actualEnd
      ? entryInstant(entry.actualEnd, entry.timezone, entry.disambiguation)
      : entryInstant(entry.end, entry.timezone, entry.disambiguation) +
          entry.overtimeMinutes * 60000;
  } catch {
    return null;
  }
}
export function entryKey(entry: RotaEntry): string {
  return JSON.stringify([
    entry.date,
    entry.duty,
    entry.category,
    entry.status,
    entry.start,
    entry.end,
    entry.timezone,
    entry.disambiguation ?? "",
    entry.overtimeMinutes,
    entry.leaveApproval ?? "",
  ]);
}
export function entryWarnings(entry: RotaEntry): string[] {
  const minutes = scheduledMinutes(entry);
  const warnings: string[] = [];
  if (minutes !== null && minutes > 16 * 60)
    warnings.push(
      "This duty exceeds 16 hours. Review the dates, finish time and overtime.",
    );
  if (entry.status === "Holiday" && entry.leaveApproval === "requested")
    warnings.push("Requested holiday is not approved leave.");
  if (entry.paidMinutes === null && entry.status === "Work")
    warnings.push(
      "Paid hours are unknown; scheduled hours do not determine payroll.",
    );
  return warnings;
}
interface Bounds {
  start: number;
  end: number;
}
interface ConflictCache {
  work: Map<RotaEntry, Bounds | Error>;
  leave: Map<RotaEntry, Bounds | Error>;
  keys: Map<RotaEntry, string>;
  zones: Map<string, boolean>;
}
function conflictCache(): ConflictCache {
  return {
    work: new Map(),
    leave: new Map(),
    keys: new Map(),
    zones: new Map(),
  };
}
function cachedKey(entry: RotaEntry, cache: ConflictCache): string {
  const key = cache.keys.get(entry);
  if (key !== undefined) return key;
  const value = entryKey(entry);
  cache.keys.set(entry, value);
  return value;
}
function workBounds(entry: RotaEntry, cache: ConflictCache): Bounds {
  const existing = cache.work.get(entry);
  if (existing instanceof Error) throw existing;
  if (existing) return existing;
  try {
    if (!entry.start || !entry.end)
      throw new Error("A work interval needs both boundaries.");
    const start = entryInstant(
      entry.start,
      entry.timezone,
      entry.disambiguation,
    );
    const end = entry.actualEnd
      ? entryInstant(entry.actualEnd, entry.timezone, entry.disambiguation)
      : entryInstant(entry.end, entry.timezone, entry.disambiguation) +
        entry.overtimeMinutes * 60000;
    const bounds = { start, end };
    cache.work.set(entry, bounds);
    return bounds;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    cache.work.set(entry, failure);
    throw failure;
  }
}
function leaveBounds(entry: RotaEntry, cache: ConflictCache): Bounds {
  const existing = cache.leave.get(entry);
  if (existing instanceof Error) throw existing;
  if (existing) return existing;
  try {
    const day = Temporal.PlainDate.from(entry.date);
    const bounds = {
      start: day.toZonedDateTime(entry.timezone).epochMilliseconds,
      end: day.add({ days: 1 }).toZonedDateTime(entry.timezone)
        .epochMilliseconds,
    };
    cache.leave.set(entry, bounds);
    return bounds;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    cache.leave.set(entry, failure);
    throw failure;
  }
}
export function validateEntry(
  entry: RotaEntry,
  existing: RotaEntry[] = [],
  excludeId?: string,
): string[] {
  return validateEntryCached(entry, existing, excludeId, conflictCache());
}
/** Cache lifetime is one synchronous operation; external mutation cannot stale a later validation. */
function validateEntryCached(
  entry: RotaEntry,
  existing: RotaEntry[],
  excludeId: string | undefined,
  cache: ConflictCache,
): string[] {
  const errors: string[] = [];
  if (!validDate(entry.date))
    errors.push("Enter a valid ISO date (YYYY-MM-DD).");
  if (!STATUSES.includes(entry.status))
    errors.push("Choose a recognised day status.");
  if (!CATEGORIES.includes(entry.category))
    errors.push("Choose a recognised shift type.");
  if (!cache.zones.has(entry.timezone))
    cache.zones.set(entry.timezone, validTimezone(entry.timezone));
  if (!cache.zones.get(entry.timezone))
    errors.push("Choose a valid rota timezone.");
  if (typeof entry.duty !== "string") errors.push("Duty must be text.");
  if (
    !Number.isInteger(entry.overtimeMinutes) ||
    entry.overtimeMinutes < 0 ||
    entry.overtimeMinutes > 2880
  )
    errors.push("Overtime must be whole minutes between 0 and 2880.");
  if (
    entry.disambiguation !== undefined &&
    !["earlier", "later"].includes(entry.disambiguation)
  )
    errors.push("Choose earlier or later for a repeated time.");
  if (
    entry.leaveApproval !== undefined &&
    !["requested", "confirmed"].includes(entry.leaveApproval)
  )
    errors.push("Leave approval must be requested or confirmed.");
  if (
    entry.status === "Holiday" &&
    entry.leaveApproval !== "confirmed" &&
    existing.some((item) => item.id === entry.id && item.status === "Work")
  )
    errors.push(
      "Requested holiday cannot replace a recorded work duty. Confirm approved leave before replacing it.",
    );
  for (const [name, value] of [
    ["Break", entry.breakMinutes],
    ["Paid time", entry.paidMinutes],
  ] as const) {
    if (
      value !== null &&
      (!Number.isFinite(value) || value < 0 || value > 2880)
    )
      errors.push(`${name} must be unknown or between 0 and 2880 minutes.`);
  }
  let start: number | null = null;
  let end: number | null = null;
  let duration: number | null = null;
  if (entry.status === "Work") {
    if (
      !entry.start ||
      !entry.end ||
      !validLocal(entry.start) ||
      !validLocal(entry.end)
    )
      errors.push("Work needs valid start and finish date/times.");
    else {
      if (entry.start.slice(0, 10) !== entry.date)
        errors.push("The duty date must match its local start date.");
      try {
        start = entryInstant(entry.start, entry.timezone, entry.disambiguation);
        const baseEnd = entryInstant(
          entry.end,
          entry.timezone,
          entry.disambiguation,
        );
        if (baseEnd <= start)
          errors.push(
            "Finish must be after start; set the next date for an overnight duty.",
          );
        duration = (baseEnd - start) / 60000 + entry.overtimeMinutes;
        end = entry.actualEnd
          ? entryInstant(entry.actualEnd, entry.timezone, entry.disambiguation)
          : baseEnd + entry.overtimeMinutes * 60000;
        if (end !== null && end <= start)
          errors.push("Actual finish must be after start.");
      } catch (error) {
        errors.push(
          `Check timezone/daylight-saving time: ${(error as Error).message}`,
        );
      }
    }
    if (entry.actualEnd && !validLocal(entry.actualEnd))
      errors.push("Actual finish needs a valid date/time.");
    if (
      duration !== null &&
      entry.breakMinutes !== null &&
      entry.breakMinutes > duration
    )
      errors.push("Break time exceeds the scheduled duty duration.");
  } else if (
    entry.start ||
    entry.end ||
    entry.actualEnd ||
    entry.overtimeMinutes > 0
  )
    errors.push(
      "Rest, leave and unknown days cannot contain work times or overtime.",
    );
  if (errors.length) return [...new Set(errors)];
  if (start !== null && end !== null) cache.work.set(entry, { start, end });
  const key = cachedKey(entry, cache);
  for (const other of existing) {
    if (other.id === excludeId || other.id === entry.id) continue;
    if (key === cachedKey(other, cache)) {
      errors.push(`Duplicate entry on ${entry.date}.`);
      continue;
    }
    if (
      entry.status === "Work" &&
      other.status === "Work" &&
      start !== null &&
      end !== null &&
      other.start
    ) {
      try {
        const otherBounds = workBounds(other, cache);
        if (start < otherBounds.end && otherBounds.start < end)
          errors.push(
            `Work overlaps duty ${other.duty || other.id} on ${other.date}.`,
          );
      } catch {
        errors.push(
          `Existing duty ${other.id} needs its timezone/time corrected before conflict review.`,
        );
      }
    } else if (
      entry.date === other.date &&
      entry.status !== "Unknown" &&
      other.status !== "Unknown"
    ) {
      if (entry.status === "Work" || other.status === "Work")
        errors.push(
          `Work conflicts with ${entry.status === "Work" ? other.status : entry.status} on ${entry.date}. Review both entries.`,
        );
      else
        errors.push(
          `A ${other.status} entry already exists on ${entry.date}; review the differing day status.`,
        );
    }
    // Leave covers its whole calendar date, including a duty starting the previous evening.
    const leave = ["Holiday", "Sick", "OtherLeave"].includes(entry.status)
      ? entry
      : ["Holiday", "Sick", "OtherLeave"].includes(other.status)
        ? other
        : null;
    const work =
      entry.status === "Work" ? entry : other.status === "Work" ? other : null;
    if (leave && work?.start && leave.date !== work.date) {
      try {
        const day = leaveBounds(leave, cache);
        const workInterval = workBounds(work, cache);
        if (workInterval.start < day.end && workInterval.end > day.start)
          errors.push(
            `Overnight work conflicts with ${leave.status} on ${leave.date}.`,
          );
      } catch {
        /* A malformed entry was already reported above. */
      }
    }
  }
  return [...new Set(errors)];
}
export function replaceEntry(
  existing: RotaEntry[],
  entry: RotaEntry,
): RotaEntry[] {
  const previous = existing.find((item) => item.id === entry.id);
  const next = {
    ...entry,
    ...(previous?.patternId
      ? { patternId: previous.patternId, exception: true }
      : {}),
  };
  const errors = validateEntry(next, existing, next.id);
  if (errors.length) throw new Error(errors.join("\n"));
  return [...existing.filter((item) => item.id !== next.id), next].sort(
    entrySort,
  );
}
export const upsertEntry = replaceEntry;
export function entrySort(a: RotaEntry, b: RotaEntry): number {
  return (
    a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? "")
  );
}
function fromTemplate(
  date: string,
  template: ShiftTemplate | undefined,
  status: DayStatus,
  timezone: string,
  patternId?: string,
): RotaEntry {
  let start: string | null = null;
  let end: string | null = null;
  if (status === "Work" && template) {
    const day = Temporal.PlainDate.from(date);
    const startTime = Temporal.PlainTime.from(template.start);
    const endTime = Temporal.PlainTime.from(template.end);
    start = day.toPlainDateTime(startTime).toString({ smallestUnit: "minute" });
    end = day
      .add({
        days: Temporal.PlainTime.compare(endTime, startTime) <= 0 ? 1 : 0,
      })
      .toPlainDateTime(endTime)
      .toString({ smallestUnit: "minute" });
  }
  return {
    id: patternId ? `${patternId}:${date}` : uid("rota"),
    date,
    duty: status === "Work" ? (template?.duty ?? "") : "",
    category: template?.category ?? "Custom",
    status,
    start,
    end,
    timezone,
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
    ...(status === "Holiday" ? { leaveApproval: "requested" as const } : {}),
    ...(patternId ? { patternId } : {}),
  };
}
export interface PatternResult {
  entries: RotaEntry[];
  warnings: string[];
}
function patternErrors(
  pattern: RepeatingPattern,
  templates: ShiftTemplate[],
  timezone: string,
): string[] {
  if (!validDate(pattern.startDate) || !validDate(pattern.until))
    return ["Pattern needs valid starting and ending dates."];
  if (pattern.until < pattern.startDate)
    return ["Pattern end must be on or after its start."];
  if (!pattern.days.length || pattern.days.length > 366)
    return ["A repeating pattern needs between 1 and 366 days."];
  if (!validTimezone(timezone))
    return ["Confirm a valid work timezone before generating a pattern."];
  for (const day of pattern.days) {
    if (!STATUSES.includes(day.status))
      return ["A pattern day has an unknown status."];
    if (day.status === "Work") {
      const template = templates.find((item) => item.id === day.templateId);
      if (
        !template ||
        !validTime(template.start) ||
        !validTime(template.end) ||
        !CATEGORIES.includes(template.category)
      )
        return ["Every workday needs a valid shift template."];
    }
  }
  return [];
}
export function generatePattern(
  pattern: RepeatingPattern,
  templates: ShiftTemplate[],
  existing: RotaEntry[],
  timezone = "Europe/London",
): PatternResult {
  const errors = patternErrors(pattern, templates, timezone);
  if (errors.length) return { entries: existing, warnings: errors };
  const start = Temporal.PlainDate.from(pattern.startDate);
  const maximum = start.add({ weeks: 52 });
  const until =
    Temporal.PlainDate.compare(
      Temporal.PlainDate.from(pattern.until),
      maximum,
    ) > 0
      ? maximum
      : Temporal.PlainDate.from(pattern.until);
  const warnings =
    pattern.until > maximum.toString()
      ? [
          "Generation is limited to 52 weeks from the starting date. Historical entries are retained.",
        ]
      : [];
  const entries = [...existing];
  const cache = conflictCache();
  for (
    let date = start, index = 0;
    Temporal.PlainDate.compare(date, until) <= 0;
    date = date.add({ days: 1 }), index++
  ) {
    const dateText = date.toString();
    if (entries.some((item) => item.date === dateText)) continue; // Preserve manual commitments and exceptions.
    const day = pattern.days[index % pattern.days.length];
    const entry = fromTemplate(
      dateText,
      templates.find((item) => item.id === day.templateId),
      day.status,
      timezone,
      pattern.id,
    );
    const problems = validateEntryCached(entry, entries, undefined, cache);
    if (problems.length) warnings.push(`${dateText}: ${problems.join(" ")}`);
    else entries.push(entry);
  }
  return { entries: entries.sort(entrySort), warnings };
}
export function updatePattern(
  pattern: RepeatingPattern,
  templates: ShiftTemplate[],
  existing: RotaEntry[],
  scope: "one" | "future" | "all",
  fromDate: string,
  timezone = "Europe/London",
): PatternResult {
  const errors = patternErrors(pattern, templates, timezone);
  if (!validDate(fromDate))
    errors.push("Choose a valid date for the pattern update.");
  if (errors.length) return { entries: existing, warnings: errors };
  if (scope === "one") {
    if (fromDate < pattern.startDate || fromDate > pattern.until)
      return {
        entries: existing,
        warnings: ["This date is outside the repeating pattern."],
      };
    const index = Temporal.PlainDate.from(pattern.startDate).until(
      Temporal.PlainDate.from(fromDate),
      { largestUnit: "day" },
    ).days;
    const day = pattern.days[index % pattern.days.length];
    const previous = existing.find(
      (item) => item.date === fromDate && item.patternId === pattern.id,
    );
    const replacement = {
      ...fromTemplate(
        fromDate,
        templates.find((item) => item.id === day.templateId),
        day.status,
        timezone,
        pattern.id,
      ),
      id: previous?.id ?? `${pattern.id}:${fromDate}`,
      exception: true,
    };
    const problems = validateEntry(replacement, existing, replacement.id);
    return problems.length
      ? { entries: existing, warnings: problems }
      : {
          entries: [
            ...existing.filter((item) => item.id !== replacement.id),
            replacement,
          ].sort(entrySort),
          warnings: [],
        };
  }
  const candidates = existing.filter(
    (item) =>
      item.patternId === pattern.id &&
      !item.exception &&
      (scope === "all" || item.date >= fromDate),
  );
  const approvalWarnings: string[] = [];
  const replaceable = candidates.filter((item) => {
    if (
      item.status !== "Work" ||
      item.date < pattern.startDate ||
      item.date > pattern.until
    )
      return true;
    const index = Temporal.PlainDate.from(pattern.startDate).until(
      Temporal.PlainDate.from(item.date),
      { largestUnit: "day" },
    ).days;
    if (pattern.days[index % pattern.days.length].status !== "Holiday")
      return true;
    approvalWarnings.push(
      `${item.date}: requested holiday cannot replace the recorded work duty. Record confirmed leave after approval.`,
    );
    return false;
  });
  const retained = existing.filter((item) => !replaceable.includes(item));
  // Generate against retained commitments, restoring any old occurrence if its replacement has a conflict.
  const result = generatePattern(pattern, templates, retained, timezone);
  result.warnings.push(...approvalWarnings);
  if (scope === "future")
    result.entries = result.entries.filter(
      (item) =>
        item.patternId !== pattern.id ||
        item.exception ||
        item.date >= fromDate ||
        retained.some((old) => old.id === item.id),
    );
  for (const old of replaceable) {
    if (
      !result.entries.some((item) => item.date === old.date) &&
      old.date >= pattern.startDate &&
      old.date <= pattern.until
    )
      result.entries.push(old);
  }
  result.entries.sort(entrySort);
  return result;
}
export interface CopyResult {
  entries: RotaEntry[];
  conflicts: { entry: RotaEntry; errors: string[] }[];
}
export function copyWeek(
  existing: RotaEntry[],
  startDate: string,
  targetDate: string,
): CopyResult {
  if (!validDate(startDate) || !validDate(targetDate))
    throw new Error("Copy week needs valid ISO starting dates.");
  const start = Temporal.PlainDate.from(startDate);
  const end = start.add({ days: 7 }).toString();
  const offset = start.until(Temporal.PlainDate.from(targetDate), {
    largestUnit: "day",
  }).days;
  const entries = [...existing];
  const conflicts: CopyResult["conflicts"] = [];
  const shift = (local: string | null | undefined) =>
    local
      ? Temporal.PlainDateTime.from(local)
          .add({ days: offset })
          .toString({ smallestUnit: "minute" })
      : null;
  for (const source of existing.filter(
    (item) => item.date >= startDate && item.date < end,
  )) {
    const entry: RotaEntry = {
      ...source,
      id: uid("copy"),
      date: Temporal.PlainDate.from(source.date)
        .add({ days: offset })
        .toString(),
      start: shift(source.start),
      end: shift(source.end),
      actualEnd: null,
      patternId: undefined,
      exception: undefined,
      ...(source.status === "Holiday"
        ? { leaveApproval: "requested" as const }
        : {}),
    };
    const errors = validateEntry(entry, entries);
    if (errors.length) conflicts.push({ entry, errors });
    else entries.push(entry);
  }
  return { entries: entries.sort(entrySort), conflicts };
}
