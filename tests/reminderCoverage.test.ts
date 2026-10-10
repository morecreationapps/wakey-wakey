import { describe, expect, it } from "vitest";
import { initialState, newSettings } from "../src/data/defaults";
import { parseBackup, exportBackup, validateBackup } from "../src/data/backup";
import { AppState, RotaEntry, Task } from "../src/model";
import { panelRollover } from "../src/engine/panelRollover";
import { planPreparation } from "../src/engine/preparation";
import { shiftDayPanels } from "../src/engine/shiftDayPanels";
import { localAt, zonedEpoch } from "../src/engine/time";
import {
  desiredReminders,
  MAX_REMINDERS,
  MAX_WEB_REMINDERS,
  reminderFingerprint,
  reminderKindSetting,
  upgradeReminderCoverage,
} from "../src/platform/reminders";

const zone = "Europe/London";
const at = (local: string) => zonedEpoch(local, zone);
const clock = (local: string) => ({ now: () => at(local) });
const duty = (
  date: string,
  category: "Early" | "Late" = "Early",
): RotaEntry => ({
  id: `shift-${date}`,
  date,
  duty: category === "Early" ? "24E" : "24L",
  category,
  status: "Work",
  start: `${date}T${category === "Early" ? "06:00" : "14:08"}`,
  end: `${date}T${category === "Early" ? "14:18" : "22:26"}`,
  timezone: zone,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  breakMinutes: null,
  paidMinutes: null,
});
const rest = (date: string): RotaEntry => ({
  ...duty(date),
  id: `rest-${date}`,
  status: "Rest",
  start: null,
  end: null,
});
const state = (
  entries: RotaEntry[] = [rest("2026-10-14"), duty("2026-10-15")],
): AppState => ({
  ...initialState(),
  entries,
  settings: {
    ...newSettings(),
    timezone: zone,
    timezoneConfirmed: true,
    onboardingComplete: true,
    additionalPrepConfirmed: true,
    remindersEnabled: true,
    caffeine: true,
    outboundMin: 15,
    outboundMax: 20,
    arrivalBuffer: 10,
    returnMinutes: 20,
    postWorkMinutes: 30,
    sleepTarget: 420,
    latency: 30,
    windDown: 60,
    beforeEarlyBed: "21:30",
    beforeEarlyWake: "05:00",
    beforeLateBed: "23:30",
    beforeLateWake: "07:00",
    earlyBed: "21:30",
    earlyWake: "05:00",
    lateBed: "23:30",
    lateWake: "07:00",
    restBed: "23:00",
    restWake: "07:00",
    freeMinutes: 0,
    reminderKinds: [
      "prepare",
      "windDown",
      "bedtime",
      "wake",
      "departure",
      "appointment",
      "transition",
      "caffeine",
      "activity",
      "task",
    ],
    routines: [
      {
        id: "ready",
        name: "Get ready",
        minutes: 30,
        includes: [],
        essential: true,
      },
    ],
    origins: Object.fromEntries(
      [
        "timezone",
        "outboundMin",
        "outboundMax",
        "arrivalBuffer",
        "returnMinutes",
        "postWorkMinutes",
        "sleepTarget",
        "latency",
        "windDown",
        "ready",
      ].map((key) => [key, "entered"]),
    ),
  },
});
const task = (
  id: string,
  title = "Lay out clothes",
  patch: Partial<Task> = {},
): Task => ({
  id,
  title,
  kind: "essential",
  minutes: 10,
  earliest: "2026-10-14T07:00",
  deadline: "2026-10-14T21:00",
  windowStart: "07:00",
  windowEnd: "21:00",
  priority: 1,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: true,
  splittable: false,
  locked: false,
  scheduledStart: "2026-10-14T20:00",
  state: "pending",
  linkedShiftId: "shift-2026-10-15",
  ...patch,
});

describe("alerts for Shift Transition and Shift Plan", () => {
  it("includes every finite active canonical row shown by both independent references", () => {
    const original = state([
      duty("2026-10-10", "Late"),
      duty("2026-10-11", "Late"),
      duty("2026-10-12", "Late"),
      rest("2026-10-13"),
      rest("2026-10-14"),
      duty("2026-10-15"),
    ]);
    const now = clock("2026-10-10T09:00");
    const refs = panelRollover(original.entries, original.settings, now);
    expect(refs.transitionShift?.date).toBe("2026-10-15");
    const records = desiredReminders(original, now);
    for (const [entry, side] of [
      [refs.transitionShift!, "transitionRows"],
      [refs.shiftPlanShift!, "shiftRows"],
    ] as const) {
      const prep = planPreparation(
        original.entries,
        [],
        original.settings,
        now,
        { selectedShift: entry },
      );
      const panels = shiftDayPanels(prep, [], original.settings);
      for (const row of panels[side]) {
        if (row.at === null || row.at <= now.now()) continue;
        expect(
          records.some(
            (record) =>
              record.entryId === entry.id &&
              record.kind === row.kind &&
              record.at === row.at,
          ),
          row.label,
        ).toBe(true);
      }
    }
    expect(
      records.filter(
        (record) =>
          record.entryId === "shift-2026-10-15" &&
          ["caffeine", "windDown", "bedtime"].includes(record.kind),
      ),
    ).toHaveLength(3);
    expect(records.some((record) => record.kind === "arrival")).toBe(true);
    expect(records.some((record) => record.kind === "workStart")).toBe(true);
    expect(records.some((record) => record.kind === "workEnd")).toBe(true);
    expect(records.some((record) => record.kind === "sleepStart")).toBe(true);
  });

  it("keeps planned finish and return due alerts after today's shift has started", () => {
    const original = state([duty("2026-10-10", "Late")]);
    const records = desiredReminders(original, clock("2026-10-10T16:00"));
    expect(records.find((record) => record.kind === "workEnd")?.at).toBe(
      at("2026-10-10T22:26"),
    );
    expect(records.find((record) => record.kind === "home")?.at).toBe(
      at("2026-10-10T22:46"),
    );
    expect(records.some((record) => record.kind === "workStart")).toBe(false);
  });

  it("retains a recorded overnight finish on the following date", () => {
    const overnight = {
      ...duty("2026-10-10", "Late"),
      category: "Night" as const,
      start: "2026-10-10T22:00",
      end: "2026-10-11T06:00",
    };
    const records = desiredReminders(
      state([overnight]),
      clock("2026-10-10T23:00"),
    );
    expect(records.find((record) => record.kind === "workEnd")?.at).toBe(
      at("2026-10-11T06:00"),
    );
    expect(records.find((record) => record.kind === "home")?.at).toBe(
      at("2026-10-11T06:20"),
    );
    const afterMidnight = desiredReminders(
      state([overnight]),
      clock("2026-10-11T02:00"),
    );
    expect(afterMidnight.find((record) => record.kind === "workEnd")?.at).toBe(
      at("2026-10-11T06:00"),
    );
    expect(afterMidnight.find((record) => record.kind === "home")?.at).toBe(
      at("2026-10-11T06:20"),
    );
  });

  it.each(["essential", "flexible", "optional"] as const)(
    "schedules a planned %s task at the actual panel time",
    (kind) => {
      const original = state();
      original.tasks = [task("clothes", "Lay out clothes", { kind })];
      const now = clock("2026-10-14T09:00");
      const prep = planPreparation(
        original.entries,
        original.tasks,
        original.settings,
        now,
        { selectedShift: original.entries[1] },
      );
      const row = shiftDayPanels(
        prep,
        original.tasks,
        original.settings,
      ).transitionRows.find((row) => row.taskId === "clothes")!;
      expect(row.status).toBe("pending");
      expect(
        desiredReminders(original, now).find(
          (record) => record.id === "wakey:task:clothes",
        )?.at,
      ).toBe(row.at);
      expect(original.tasks[0].scheduledStart).toBe("2026-10-14T20:00");
    },
  );

  it("includes manually recorded tasks on the shift day", () => {
    const original = state([rest("2026-10-14"), duty("2026-10-15", "Late")]);
    original.tasks = [
      task("after", "Call the dentist", {
        earliest: "2026-10-15T10:00",
        deadline: "2026-10-15T12:00",
        scheduledStart: "2026-10-15T11:00",
        windowStart: "10:00",
        windowEnd: "12:00",
      }),
    ];
    expect(
      desiredReminders(original, clock("2026-10-14T09:00")).find(
        (record) => record.id === "wakey:task:after",
      )?.at,
    ).toBe(at("2026-10-15T11:00"));
  });

  it("suppresses completed, skipped, deferred and conflicted task rows", () => {
    const original = state();
    original.tasks = [
      task("done", "Completed task", { state: "completed" }),
      task("skipped", "Skipped task", { state: "skipped" }),
      task("deferred", "Deferred task", { state: "deferred" }),
      task("conflict", "Conflicting task", {
        scheduledStart: "2026-10-14T22:30",
        earliest: "2026-10-14T20:00",
        deadline: "2026-10-14T23:00",
        windowStart: "20:00",
        windowEnd: "23:00",
      }),
    ];
    expect(
      desiredReminders(original, clock("2026-10-14T09:00")).filter(
        (record) => record.kind === "task",
      ),
    ).toEqual([]);
  });

  it("does not duplicate a saved bedtime merged with the canonical activity", () => {
    const original = state();
    original.tasks = [
      task("bed", "Go to sleep", {
        scheduledStart: "2026-10-14T21:30",
        minutes: 30,
        earliest: "2026-10-14T00:00",
        deadline: "2026-10-15T00:00",
        windowStart: "00:00",
        windowEnd: "00:00",
      }),
    ];
    const records = desiredReminders(original, clock("2026-10-14T09:00"));
    expect(
      records.filter((record) => record.at === at("2026-10-14T21:30")),
    ).toHaveLength(1);
    expect(
      records.find((record) => record.at === at("2026-10-14T21:30"))?.kind,
    ).toBe("bedtime");
  });

  it("exposes each split task part exactly once", () => {
    const original = state();
    original.tasks = [
      task("laundry", "Laundry", {
        scheduledStart: null,
        minutes: 90,
        splittable: true,
        earliest: "2026-10-14T09:00",
        deadline: "2026-10-14T11:30",
        windowStart: "09:00",
        windowEnd: "11:30",
      }),
      task("appointment", "Fixed call", {
        kind: "fixed",
        movable: false,
        minutes: 60,
        scheduledStart: "2026-10-14T09:30",
        earliest: "2026-10-14T09:00",
        deadline: "2026-10-14T11:30",
        windowStart: "09:00",
        windowEnd: "11:30",
      }),
    ];
    const records = desiredReminders(original, clock("2026-10-14T08:00"));
    const parts = records.filter((record) =>
      record.id.startsWith("wakey:task:laundry"),
    );
    expect(parts.map((record) => localAt(record.at, zone))).toEqual([
      "2026-10-14T09:00",
      "2026-10-14T10:30",
    ]);
    expect(new Set(parts.map((record) => record.id)).size).toBe(2);
  });

  it("updates alerts after an edit and removes them after deletion without mutating the source", () => {
    const original = state();
    original.tasks = [task("clothes")];
    const before = exportBackup(original),
      now = clock("2026-10-14T09:00");
    expect(
      desiredReminders(original, now).find(
        (record) => record.id === "wakey:task:clothes",
      )?.at,
    ).toBe(at("2026-10-14T20:00"));
    const edited = {
      ...original,
      tasks: [{ ...original.tasks[0], scheduledStart: "2026-10-14T19:45" }],
    };
    expect(
      desiredReminders(edited, now).find(
        (record) => record.id === "wakey:task:clothes",
      )?.at,
    ).toBe(at("2026-10-14T19:45"));
    expect(
      desiredReminders({ ...original, tasks: [] }, now).some(
        (record) => record.id === "wakey:task:clothes",
      ),
    ).toBe(false);
    expect(exportBackup(original)).toBe(before);
  });

  it("expands recurring tasks and suppresses only inactive occurrences", () => {
    const original = state([
      rest("2026-10-14"),
      duty("2026-10-15"),
      rest("2026-10-16"),
      duty("2026-10-17"),
    ]);
    original.tasks = [
      task("repeat", "Lay out clothes", {
        linkedShiftId: undefined,
        recurrence: "daily",
        deadline: "2026-10-17T21:00",
        occurrenceStates: {
          "2026-10-14": "completed",
          "2026-10-15": "skipped",
          "2026-10-16": "pending",
        },
      }),
    ];
    const records = desiredReminders(
      original,
      clock("2026-10-14T09:00"),
    ).filter((record) => record.id.startsWith("wakey:task:repeat"));
    expect(records.some((record) => record.id.endsWith("2026-10-16"))).toBe(
      true,
    );
    expect(
      records.some(
        (record) =>
          record.id.endsWith("2026-10-14") || record.id.endsWith("2026-10-15"),
      ),
    ).toBe(false);
  });

  it("includes a weekly occurrence when its original start predates the panel horizon", () => {
    const original = state();
    original.tasks = [
      task("weekly", "Weekly preparation", {
        linkedShiftId: undefined,
        recurrence: "weekly",
        scheduledStart: null,
        earliest: "2026-10-07T19:00",
        deadline: "2026-10-16T20:30",
        windowStart: "19:00",
        windowEnd: "20:30",
      }),
    ];
    const records = desiredReminders(original, clock("2026-10-14T09:00"));
    const due = records.find(
      (record) => record.id === "wakey:task:weekly:2026-10-14",
    );
    expect(due).toBeDefined();
    expect(localAt(due!.at, zone).slice(0, 10)).toBe("2026-10-14");
  });

  it("preserves timezone wall clocks across a daylight-saving change", () => {
    const original = state([rest("2026-10-24"), duty("2026-10-25")]);
    const records = desiredReminders(original, clock("2026-10-24T09:00"));
    expect(records.find((record) => record.kind === "wake")?.at).toBe(
      at("2026-10-25T05:00"),
    );
    expect(records.find((record) => record.kind === "bedtime")?.at).toBe(
      at("2026-10-24T21:30"),
    );
  });

  it("keeps activity/task switches independently editable after legacy opt-in upgrade", () => {
    const original = state();
    const legacy = {
      ...original.settings,
      reminderCoverageVersion: undefined,
      reminderKinds: ["departure"],
    };
    const upgraded = upgradeReminderCoverage(legacy);
    expect(upgraded.reminderKinds).toEqual(["departure", "activity", "task"]);
    expect(legacy.reminderKinds).toEqual(["departure"]);
    const optedOut = { ...upgraded, reminderKinds: ["departure"] };
    expect(upgradeReminderCoverage(optedOut)).toBe(optedOut);
    expect(
      desiredReminders(
        { ...original, settings: optedOut },
        clock("2026-10-14T09:00"),
      ).every((record) => record.kind === "departure"),
    ).toBe(true);
    expect(
      upgradeReminderCoverage({ ...legacy, remindersEnabled: false })
        .reminderCoverageVersion,
    ).toBeUndefined();
    expect(reminderKindSetting("workEnd")).toBe("activity");
    expect(reminderKindSetting("task")).toBe("task");
  });

  it("validates and round-trips new coverage fields without rewriting legacy backups", () => {
    const original = state();
    expect(parseBackup(exportBackup(original))).toEqual(original);
    const legacy = {
      ...original,
      settings: { ...original.settings, reminderCoverageVersion: undefined },
    };
    expect(
      validateBackup(legacy).settings.reminderCoverageVersion,
    ).toBeUndefined();
    expect(() =>
      validateBackup({
        ...original,
        settings: { ...original.settings, reminderCoverageVersion: 2 },
      }),
    ).toThrow("reminderCoverageVersion");
  });

  it("caps native queues at 60 while allowing web to retain the full busy horizon", () => {
    const original = state(
      Array.from({ length: 20 }, (_, index) =>
        duty(`2026-10-${String(10 + index).padStart(2, "0")}`),
      ),
    );
    const now = clock("2026-10-09T12:00");
    const native = desiredReminders(original, now),
      web = desiredReminders(original, now, { max: MAX_WEB_REMINDERS });
    expect(native).toHaveLength(MAX_REMINDERS);
    expect(web.length).toBeGreaterThan(native.length);
    expect(native).toEqual(web.slice(0, MAX_REMINDERS));
    expect(desiredReminders(original, now, { max: 3 })).toHaveLength(3);
    expect(desiredReminders(original, now, { max: Number.NaN })).toEqual(
      native,
    );
    expect(
      web.every((record) => record.at <= now.now() + 14 * 86_400_000),
    ).toBe(true);
  });

  it("keeps a one-day background cache consistent with the full foreground horizon as days advance", () => {
    const original = state([
      rest("2026-10-14"),
      duty("2026-10-15"),
      rest("2026-10-16"),
      duty("2026-10-17"),
    ]);
    original.tasks = [
      task("cache-repeat", "Lay out clothes", {
        linkedShiftId: undefined,
        kind: "fixed",
        movable: false,
        locked: true,
        recurrence: "daily",
        deadline: "2026-10-18T21:00",
        occurrenceStates: { "2026-10-14": "completed" },
      }),
    ];
    for (const local of [
      "2026-10-14T12:00",
      "2026-10-15T00:01",
      "2026-10-16T12:00",
    ]) {
      const now = clock(local),
        full = desiredReminders(original, now, { max: MAX_WEB_REMINDERS }),
        cache = desiredReminders(original, now, {
          max: MAX_WEB_REMINDERS,
          horizonDays: 1,
        });
      expect(cache.every((record) => record.at <= now.now() + 86_400_000)).toBe(
        true,
      );
      expect(cache.map(({ id, at }) => ({ id, at }))).toEqual(
        full
          .filter((record) => record.at <= now.now() + 86_400_000)
          .map(({ id, at }) => ({ id, at })),
      );
    }
    const refreshed = desiredReminders(original, clock("2026-10-16T12:00"), {
      max: MAX_WEB_REMINDERS,
      horizonDays: 1,
    });
    expect(
      refreshed.some(
        (record) => record.id === "wakey:task:cache-repeat:2026-10-16",
      ),
    ).toBe(true);
    expect(
      refreshed.some(
        (record) =>
          record.kind === "bedtime" &&
          localAt(record.at, zone).slice(0, 10) === "2026-10-16",
      ),
    ).toBe(true);
    expect(
      desiredReminders(original, clock("2026-10-14T12:00"), {
        max: MAX_WEB_REMINDERS,
        horizonDays: 0,
      }),
    ).toEqual(
      desiredReminders(original, clock("2026-10-14T12:00"), {
        max: MAX_WEB_REMINDERS,
        horizonDays: 1,
      }),
    );
  });

  it("bounds long Unicode task previews and identifiers without changing full saved text", () => {
    const original = state(),
      shiftId = "班".repeat(200),
      taskId = "項".repeat(200),
      title = "準".repeat(1000);
    original.entries[1].id = shiftId;
    original.tasks = [
      task(taskId, title, {
        kind: "fixed",
        movable: false,
        locked: true,
        linkedShiftId: shiftId,
        travelMinutes: 10,
      }),
    ];
    const now = clock("2026-10-14T09:00"),
      records = desiredReminders(original, now),
      first = records.find((record) => record.title.startsWith("準"));
    expect(first).toBeDefined();
    expect(first!.id.startsWith("wakey:long:")).toBe(true);
    expect(first!.id.length).toBeLessThanOrEqual(200);
    expect(first!.title.length).toBeLessThanOrEqual(120);
    expect(
      records.find((record) => record.title === "Leave for appointment")!.body
        .length,
    ).toBeLessThanOrEqual(240);
    for (const record of records) {
      const payload = JSON.stringify({
        ownerId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        revision: "33333333-3333-4333-8333-333333333333",
        reminder: record,
        fingerprint: reminderFingerprint(record),
      });
      expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(4096);
    }
    expect(desiredReminders(original, now).map((record) => record.id)).toEqual(
      records.map((record) => record.id),
    );
    expect(original.tasks[0].title).toBe(title);
    expect(original.tasks[0].id).toBe(taskId);
  });
});
