import { Temporal } from "@js-temporal/polyfill";
import {
  Clock,
  DayStatus,
  RotaEntry,
  ShiftCategory,
  systemClock,
  uid,
} from "../model";
import {
  CATEGORIES,
  entryInstant,
  entryKey,
  entrySort,
  entryWarnings,
  STATUSES,
  validateEntry,
  validDate,
  validTime,
  validTimezone,
} from "./rota";

export interface ImportRow {
  line: number;
  entry: RotaEntry | null;
  errors: string[];
  warnings: string[];
  duplicate: boolean;
}
export interface ImportPreview {
  rows: ImportRow[];
  errors: string[];
}
export const CSV_HELP =
  "CSV: date,duty,shift_type,start_time,end_time,end_date,status,overtime_minutes,notes. Use ISO YYYY-MM-DD and 24-hour HH:mm. Work needs a shift type and times. Rest/Holiday/Sick/OtherLeave/Unknown have blank times. End date is optional; an earlier finish clock time means next day. Holiday defaults to requested; leave_approval=confirmed is explicit. Optional fields: timezone,break_minutes,paid_minutes,actual_end_date,actual_end_time,disambiguation. UK slash dates require choosing UK format explicitly.";

/** RFC 4180-style CSV; no evaluation or numeric coercion of text columns. */
function csvRows(text: string): { fields: string[]; line: number }[] {
  const rows: { fields: string[]; line: number }[] = [];
  let fields: string[] = [],
    field = "",
    quoted = false,
    closedQuote = false,
    line = 1,
    rowLine = 1;
  const push = () => {
    fields.push(field);
    if (fields.some((value) => value.trim()))
      rows.push({ fields, line: rowLine });
    fields = [];
    field = "";
    closedQuote = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (!field && !closedQuote) quoted = true;
      else throw new Error(`CSV line ${line}: unexpected quote.`);
    } else if (quoted) {
      field += char;
      if (char === "\n") line++;
    } else if (char === ",") {
      fields.push(field);
      field = "";
      closedQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      push();
      line++;
      rowLine = line;
    } else if (closedQuote && !/\s/.test(char))
      throw new Error(`CSV line ${line}: characters after a quoted value.`);
    else if (!closedQuote) field += char;
  }
  if (quoted)
    throw new Error(`CSV line ${rowLine}: quoted value is not closed.`);
  push();
  return rows;
}
function parseDate(value: string, format: "UK" | "ISO" | undefined): string {
  if (validDate(value)) return value;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    if (format !== "UK")
      throw new Error(
        "Slash dates require explicitly selecting UK DD/MM/YYYY; ISO YYYY-MM-DD is the CSV default.",
      );
    const [day, month, year] = value.split("/").map(Number);
    return Temporal.PlainDate.from(
      { year, month, day },
      { overflow: "reject" },
    ).toString();
  }
  throw new Error(
    `Invalid or missing date: ${value || "(blank)"}. Use YYYY-MM-DD.`,
  );
}
function parseStatus(value: string): {
  status: DayStatus;
  approval?: "requested" | "confirmed";
} {
  const normal = value.toLowerCase().replace(/[ _-]/g, "");
  const names: Record<string, DayStatus> = {
    work: "Work",
    duty: "Work",
    rest: "Rest",
    holiday: "Holiday",
    annualleave: "Holiday",
    sick: "Sick",
    sickleave: "Sick",
    otherleave: "OtherLeave",
    unknown: "Unknown",
    requestedholiday: "Holiday",
    confirmedholiday: "Holiday",
  };
  if (!names[normal])
    throw new Error(`Unrecognised status: ${value || "(blank)"}.`);
  return {
    status: names[normal],
    ...(names[normal] === "Holiday"
      ? { approval: normal === "confirmedholiday" ? "confirmed" : "requested" }
      : {}),
  };
}
function parseNumber(
  value: string,
  label: string,
  optional = false,
): number | null {
  if (!value) return optional ? null : 0;
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(`${label} must be non-negative minutes.`);
  return Number(value);
}
function baseEntry(
  date: string,
  timezone: string,
  status: DayStatus,
): RotaEntry {
  return {
    id: uid("import"),
    date,
    duty: "",
    category: "Custom",
    status,
    start: null,
    end: null,
    timezone,
    overtimeMinutes: 0,
    location: "",
    notes: "",
    breakMinutes: null,
    paidMinutes: null,
  };
}
function csvEntry(
  values: Record<string, string>,
  timezone: string,
  dateFormat?: "UK" | "ISO",
): { entry: RotaEntry; warnings: string[] } {
  const date = parseDate(values.date ?? "", dateFormat);
  const state = parseStatus(values.status ?? "");
  const entry = baseEntry(
    date,
    values.timezone?.trim() || timezone,
    state.status,
  );
  const decodeText = (value: string | undefined) =>
    values.text_encoding === "apostrophe-v1" && value?.startsWith("'")
      ? value.slice(1)
      : (value ?? "");
  entry.duty = decodeText(values.duty);
  entry.notes = decodeText(values.notes);
  entry.location = decodeText(values.location);
  if (values.timezone) entry.timezone = decodeText(values.timezone);
  entry.leaveApproval = state.approval;
  if (values.leave_approval) {
    if (
      !["requested", "confirmed"].includes(values.leave_approval.toLowerCase())
    )
      throw new Error("leave_approval must be requested or confirmed.");
    entry.leaveApproval = values.leave_approval.toLowerCase() as
      "requested" | "confirmed";
  }
  entry.overtimeMinutes = parseNumber(
    values.overtime_minutes ?? "",
    "Overtime",
  )!;
  entry.breakMinutes = parseNumber(values.break_minutes ?? "", "Break", true);
  entry.paidMinutes = parseNumber(values.paid_minutes ?? "", "Paid time", true);
  if (values.disambiguation) {
    if (!["earlier", "later"].includes(values.disambiguation))
      throw new Error("disambiguation must be earlier or later.");
    entry.disambiguation = values.disambiguation as "earlier" | "later";
  }
  const category = CATEGORIES.find(
    (value) => value.toLowerCase() === values.shift_type?.toLowerCase(),
  );
  if ((state.status === "Work" || values.shift_type) && !category)
    throw new Error(
      "shift_type must be Early, Middle, Late, Night or Custom; it is required for work.",
    );
  entry.category = category ?? "Custom";
  const warnings: string[] = [];
  if (state.status === "Work") {
    if (
      !validTime(values.start_time ?? "") ||
      !validTime(values.end_time ?? "")
    )
      throw new Error("Work times must be unambiguous 24-hour HH:mm.");
    const startTime = Temporal.PlainTime.from(values.start_time);
    const endTime = Temporal.PlainTime.from(values.end_time);
    const startDay = Temporal.PlainDate.from(date);
    const crossesMidnight = Temporal.PlainTime.compare(endTime, startTime) <= 0;
    const endDay = values.end_date
      ? Temporal.PlainDate.from(parseDate(values.end_date, dateFormat))
      : startDay.add({ days: crossesMidnight ? 1 : 0 });
    entry.start = startDay
      .toPlainDateTime(startTime)
      .toString({ smallestUnit: "minute" });
    entry.end = endDay
      .toPlainDateTime(endTime)
      .toString({ smallestUnit: "minute" });
    if (!values.end_date && crossesMidnight)
      warnings.push(
        "Finish is on the following date; review the overnight duty.",
      );
    if (values.actual_end_time || values.actual_end_date) {
      if (!validTime(values.actual_end_time ?? "") || !values.actual_end_date)
        throw new Error(
          "Actual finish needs both actual_end_date and a 24-hour actual_end_time.",
        );
      entry.actualEnd = Temporal.PlainDate.from(
        parseDate(values.actual_end_date, dateFormat),
      )
        .toPlainDateTime(Temporal.PlainTime.from(values.actual_end_time))
        .toString({ smallestUnit: "minute" });
    }
  } else if (
    values.start_time ||
    values.end_time ||
    values.end_date ||
    values.actual_end_time ||
    values.actual_end_date
  )
    throw new Error("Non-work days must have blank work times/dates.");
  return { entry, warnings };
}
function pastedEntry(
  line: string,
  timezone: string,
): { entry: RotaEntry; warnings: string[] } {
  const match = line.match(
    /^\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s*:\s*(.*?)\s*$/,
  );
  if (!match)
    throw new Error(
      "Use DD/MM/YYYY: Duty CODE, HH:mm-HH:mm or DD/MM/YYYY: REST. Pasted-text dates explicitly use UK order.",
    );
  const date = parseDate(match[1], "UK");
  const work = match[2].match(
    /^Duty\s+(.+?)\s*,\s*(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})\s*$/i,
  );
  if (work) {
    const category =
      /E$/i.test(work[1]) || work[2] === "06:00"
        ? "Early"
        : /L$/i.test(work[1]) || work[2] === "14:08"
          ? "Late"
          : Temporal.PlainTime.compare(
                Temporal.PlainTime.from(work[3]),
                Temporal.PlainTime.from(work[2]),
              ) <= 0
            ? "Night"
            : "Custom";
    return csvEntry(
      {
        date,
        duty: work[1],
        shift_type: category,
        start_time: work[2],
        end_time: work[3],
        status: "Work",
      },
      timezone,
    );
  }
  const state = parseStatus(match[2]);
  if (state.status === "Work")
    throw new Error("Work needs a duty code and start/finish times.");
  return {
    entry: {
      ...baseEntry(date, timezone, state.status),
      ...(state.approval ? { leaveApproval: state.approval } : {}),
    },
    warnings: [],
  };
}
export function previewImport(
  text: string,
  timezone: string,
  existing: RotaEntry[] = [],
  dateFormat?: "UK" | "ISO",
): ImportPreview {
  const preview: ImportPreview = { rows: [], errors: [] };
  if (!validTimezone(timezone))
    return {
      rows: [],
      errors: ["Confirm a valid rota timezone before import."],
    };
  if (text.length > 5_000_000)
    return {
      rows: [],
      errors: [
        "Import is larger than the 5 MB limit. Split it into smaller files.",
      ],
    };
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return { rows: [], errors: ["The import is empty."] };
  const firstLine = clean.split(/\r?\n/, 1)[0];
  let sources: {
    line: number;
    parse: () => { entry: RotaEntry; warnings: string[] };
  }[] = [];
  if (/^\s*"?date"?\s*,/i.test(firstLine)) {
    try {
      const csv = csvRows(clean);
      const headers = csv[0].fields.map((value) => value.trim().toLowerCase());
      if (new Set(headers).size !== headers.length)
        throw new Error("CSV has repeated column names.");
      if (!headers.includes("date") || !headers.includes("status"))
        throw new Error("CSV must contain date and status columns.");
      sources = csv.slice(1).map((row) => ({
        line: row.line,
        parse: () => {
          if (row.fields.length !== headers.length)
            throw new Error(
              `Expected ${headers.length} columns, found ${row.fields.length}.`,
            );
          const values: Record<string, string> = {};
          headers.forEach((header, index) => {
            values[header] = ["notes", "location", "duty"].includes(header)
              ? row.fields[index]
              : row.fields[index].trim();
          });
          return csvEntry(values, timezone, dateFormat);
        },
      }));
    } catch (error) {
      preview.errors.push((error as Error).message);
      return preview;
    }
  } else
    sources = clean
      .split(/\r?\n/)
      .map((line, index) => ({
        line: index + 1,
        parse: () => pastedEntry(line, timezone),
        text: line,
      }))
      .filter((source) => source.text.trim());
  const accepted = [...existing];
  for (const source of sources) {
    const row: ImportRow = {
      line: source.line,
      entry: null,
      errors: [],
      warnings: [],
      duplicate: false,
    };
    try {
      const result = source.parse();
      row.entry = result.entry;
      row.warnings = [...result.warnings, ...entryWarnings(result.entry)];
      row.duplicate = accepted.some(
        (entry) => entryKey(entry) === entryKey(result.entry),
      );
      row.errors = validateEntry(result.entry, row.duplicate ? [] : accepted);
      if (row.duplicate)
        row.warnings.push(
          "Duplicate duty/day: it will be skipped without changing the saved entry.",
        );
      if (!row.errors.length && !row.duplicate) accepted.push(result.entry);
    } catch (error) {
      row.errors.push((error as Error).message);
    }
    preview.rows.push(row);
  }
  return preview;
}
/** Revalidate against current state as the preview may be stale. Never overwrite. */
export function importAccepted(
  preview: ImportPreview,
  existing: RotaEntry[],
): RotaEntry[] {
  if (preview.errors.length) return existing;
  const entries = [...existing];
  for (const row of preview.rows) {
    if (
      !row.entry ||
      row.errors.length ||
      row.duplicate ||
      entries.some((entry) => entryKey(entry) === entryKey(row.entry!))
    )
      continue;
    if (!validateEntry(row.entry, entries).length) entries.push(row.entry);
  }
  return entries.sort(entrySort);
}
const csvValue = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
// Spreadsheet formula handling is explicit and reversible. Quoting alone does not neutralise formulas.
const spreadsheetText = (value: string): string =>
  /^\s*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n']/.test(value)
    ? "'" + value
    : value;
export function exportCSV(
  entries: RotaEntry[],
  options: { includeNotes?: boolean } = {},
): string {
  const header = [
    "date",
    "duty",
    "shift_type",
    "start_time",
    "end_time",
    "end_date",
    "status",
    "overtime_minutes",
    "leave_approval",
    "timezone",
    "break_minutes",
    "paid_minutes",
    "actual_end_date",
    "actual_end_time",
    "disambiguation",
    "text_encoding",
    ...(options.includeNotes ? ["notes"] : []),
  ];
  const rows = [...entries]
    .sort(entrySort)
    .map((entry) =>
      [
        entry.date,
        spreadsheetText(entry.duty),
        entry.category,
        entry.start?.slice(11, 16),
        entry.end?.slice(11, 16),
        entry.end?.slice(0, 10),
        entry.status,
        entry.overtimeMinutes,
        entry.leaveApproval,
        spreadsheetText(entry.timezone),
        entry.breakMinutes,
        entry.paidMinutes,
        entry.actualEnd?.slice(0, 10),
        entry.actualEnd?.slice(11, 16),
        entry.disambiguation,
        "apostrophe-v1",
        ...(options.includeNotes ? [spreadsheetText(entry.notes)] : []),
      ]
        .map(csvValue)
        .join(","),
    );
  return [header.join(","), ...rows].join("\r\n");
}
const icsEscape = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
function foldLine(line: string): string {
  let result = "",
    length = 0;
  for (const char of line) {
    const code = char.codePointAt(0)!;
    const bytes = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (length + bytes > 75) {
      result += "\r\n ";
      length = 1;
    }
    result += char;
    length += bytes;
  }
  return result;
}
const icsUTC = (milliseconds: number): string =>
  Temporal.Instant.fromEpochMilliseconds(milliseconds)
    .toString({ smallestUnit: "second" })
    .replace(/[-:]/g, "");
/** UTC instants avoid floating local time; original work timezone is retained as metadata. */
export function exportICS(
  entries: RotaEntry[],
  options: { includeNotes?: boolean; clock?: Clock } = {},
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wakey-Wakey//Personal Rota//EN",
    "CALSCALE:GREGORIAN",
  ];
  const stamp = icsUTC((options.clock ?? systemClock).now());
  const seen = new Set<string>();
  for (const entry of [...entries].sort(entrySort)) {
    if (seen.has(entryKey(entry)) || entry.status === "Unknown") continue;
    const errors = validateEntry(entry);
    if (errors.length)
      throw new Error(`Cannot export ${entry.date}: ${errors.join(" ")}`);
    seen.add(entryKey(entry));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(entry.id)}@wakey-wakey.local`,
      `DTSTAMP:${stamp}`,
    );
    if (entry.status === "Work" && entry.start && entry.end) {
      lines.push(
        `DTSTART:${icsUTC(entryInstant(entry.start, entry.timezone, entry.disambiguation))}`,
        `DTEND:${icsUTC(entryInstant(entry.end, entry.timezone, entry.disambiguation) + entry.overtimeMinutes * 60000)}`,
      );
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${entry.date.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${Temporal.PlainDate.from(entry.date).add({ days: 1 }).toString().replace(/-/g, "")}`,
      );
    }
    const title =
      entry.status === "Work"
        ? `${entry.category} shift${entry.duty ? ` · ${entry.duty}` : ""}`
        : `${entry.status}${entry.status === "Holiday" && entry.leaveApproval !== "confirmed" ? " (requested)" : ""}`;
    lines.push(
      `SUMMARY:${icsEscape(title)}`,
      `X-WAKEY-WAKEY-TIMEZONE:${icsEscape(entry.timezone)}`,
    );
    if (entry.status === "Holiday")
      lines.push(
        `STATUS:${entry.leaveApproval === "confirmed" ? "CONFIRMED" : "TENTATIVE"}`,
      );
    if (entry.location) lines.push(`LOCATION:${icsEscape(entry.location)}`);
    if (options.includeNotes && entry.notes)
      lines.push(`DESCRIPTION:${icsEscape(entry.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
