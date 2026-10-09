import { Settings, Task } from "../model";
import {
  PreparationPlan,
  PreparationRow,
  recognizePreparationActivity,
} from "./preparation";
import { addDays, localAt, MINUTE, zonedEpoch } from "./time";

export interface ShiftDayPanels {
  preparationDate?: string;
  shiftDate?: string;
  timezone: string;
  transitionRows: PreparationRow[];
  shiftRows: PreparationRow[];
  /** Relevant saved tasks without a time, or deliberately entered on another date. */
  reviewRows: PreparationRow[];
  /** Full sleep-plan events outside these two dates remain available in Sleep. */
  otherShiftEvents: PreparationRow[];
}

const rowKey = (row: PreparationRow) =>
  `${row.taskId}:${row.occurrenceDate ?? "once"}:${row.at}:${row.end}`;
const order = (a: PreparationRow, b: PreparationRow) =>
  (a.at ?? Infinity) - (b.at ?? Infinity) || a.id.localeCompare(b.id);
const distinctText = (...items: (string | undefined)[]) =>
  [...new Set(items.filter((item): item is string => !!item))].join(" ");

/** Project the selected shift's canonical plan and actual saved tasks by date.
 * This changes neither scheduling calculations nor saved task/settings data.
 * The previous date is a calendar operation in the selected shift's timezone,
 * including nights containing a daylight-saving change.
 */
export function shiftDayPanels(
  preparation: PreparationPlan,
  tasks: Task[],
  settings: Settings,
): ShiftDayPanels {
  const entry = preparation.nextShift;
  const result: ShiftDayPanels = {
    timezone: entry?.timezone ?? settings.timezone,
    transitionRows: [],
    shiftRows: [],
    reviewRows: [],
    otherShiftEvents: [],
  };
  if (!entry?.start) return result;
  try {
    result.shiftDate = localAt(
      zonedEpoch(entry.start, entry.timezone, entry.disambiguation),
      entry.timezone,
    ).slice(0, 10);
    result.preparationDate = addDays(result.shiftDate, -1);
  } catch {
    // An invalid shift cannot establish either panel's calendar date.
    return result;
  }
  const dateOf = (at: number | null) => {
    if (at === null || !Number.isFinite(at)) return undefined;
    try {
      return localAt(at, result.timezone).slice(0, 10);
    } catch {
      return undefined;
    }
  };
  const destination = (row: PreparationRow) => {
    const date = dateOf(row.at);
    return date === result.preparationDate
      ? result.transitionRows
      : date === result.shiftDate
        ? result.shiftRows
        : undefined;
  };
  const canonicalRows =
    preparation.shiftPlan?.entryId === entry.id
      ? preparation.shiftPlan.events.map((event, index): PreparationRow => ({
          id: `shift-event:${entry.id}:${event.kind}:${index}`,
          label: event.label,
          kind: event.kind,
          at: event.at,
          end: null,
          minutes: null,
          status: "planned",
          why: event.why,
        }))
      : [];
  for (const row of canonicalRows)
    (destination(row) ?? result.otherShiftEvents).push(row);

  const savedTasks = new Map(tasks.map((task) => [task.id, task]));
  const taskRows: PreparationRow[] = [];
  const represented = new Set<string>();
  const representedOccurrences = new Set<string>();
  const append = (row: PreparationRow) => {
    const key = rowKey(row);
    if (represented.has(key)) return;
    represented.add(key);
    representedOccurrences.add(`${row.taskId}:${row.occurrenceDate ?? "once"}`);
    taskRows.push({ ...row });
  };
  for (const row of preparation.rows) {
    if (!row.taskId) continue; // Replace generated transition stages with the canonical plan.
    const task = savedTasks.get(row.taskId);
    if (!task || (task.linkedShiftId && task.linkedShiftId !== entry.id))
      continue;
    append(row);
  }
  for (const placement of preparation.placements) {
    const task = savedTasks.get(placement.taskId);
    if (!task || (task.linkedShiftId && task.linkedShiftId !== entry.id))
      continue;
    const occurrence = `${task.id}:${placement.occurrenceDate ?? "once"}`;
    // Preparation rows already carry the reviewed result for this occurrence.
    if (representedOccurrences.has(occurrence)) continue;
    const parts = placement.parts?.length
      ? placement.parts
      : placement.start !== null && placement.end !== null
        ? [{ start: placement.start, end: placement.end }]
        : [];
    const state = placement.occurrenceDate
      ? (task.occurrenceStates?.[placement.occurrenceDate] ?? task.state)
      : task.state;
    const active = !["completed", "skipped", "deferred"].includes(state);
    const kind = recognizePreparationActivity(task.title);
    const base: PreparationRow = {
      id: `task:${task.id}:${placement.occurrenceDate ?? "once"}`,
      label: task.title,
      kind:
        kind === "sleep"
          ? "bedtime"
          : kind === "windDown"
            ? "windDown"
            : "task",
      at: null,
      end: null,
      minutes: task.minutes,
      status: !active ? state : placement.conflict ? "conflict" : "needs-input",
      why: placement.reason,
      taskId: task.id,
      ...(placement.occurrenceDate
        ? { occurrenceDate: placement.occurrenceDate }
        : {}),
      ...(placement.conflict ? { conflict: placement.conflict } : {}),
    };
    if (!parts.length) {
      const relevant =
        task.linkedShiftId === entry.id ||
        [task.scheduledStart, task.earliest, task.deadline].some((value) => {
          if (!value) return false;
          try {
            const date = dateOf(zonedEpoch(value, settings.timezone));
            return date === result.preparationDate || date === result.shiftDate;
          } catch {
            return false;
          }
        });
      if (relevant) append(base);
      continue;
    }
    for (const [index, part] of parts.entries()) {
      const row: PreparationRow = {
        ...base,
        id: `${base.id}${parts.length > 1 ? `:part:${index}` : ""}`,
        at: part.start,
        end: part.end,
        minutes: (part.end - part.start) / MINUTE,
        status: !active ? state : placement.conflict ? "conflict" : state,
      };
      if (destination(row) || task.linkedShiftId === entry.id) append(row);
    }
  }

  for (const row of taskRows) {
    const target = destination(row);
    if (!target) {
      result.reviewRows.push(row);
      continue;
    }
    // Keep the canonical calculated bedtime if a user has chosen another time.
    // Only the same activity at the same instant is a duplicate presentation.
    const match = ["windDown", "bedtime"].includes(row.kind)
      ? target.find(
          (event) =>
            !event.taskId && event.kind === row.kind && event.at === row.at,
        )
      : undefined;
    if (match) {
      match.taskId = row.taskId;
      match.occurrenceDate = row.occurrenceDate;
      match.end = row.end;
      match.minutes = row.minutes;
      match.status = row.status;
      match.conflict = row.conflict;
      match.why = distinctText(match.why, `Saved task: ${row.label}.`, row.why);
    } else target.push(row);
  }
  result.transitionRows.sort(order);
  result.shiftRows.sort(order);
  result.reviewRows.sort(order);
  result.otherShiftEvents.sort(order);
  return result;
}
