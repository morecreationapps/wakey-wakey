import { describe, expect, it } from "vitest";
import { newSettings, suppliedProfile } from "../src/data/defaults";
import { Clock, RotaEntry, Settings, Task } from "../src/model";
import {
  effectiveEnd,
  essentialPreparation,
  nextWork,
  planShift,
  planTasks,
  transitions,
  workBounds,
} from "../src/engine/planner";
import {
  addDays,
  dateInZone,
  displayDate,
  localAt,
  MINUTE,
  zonedEpoch,
} from "../src/engine/time";

const tz = "Europe/London";
const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...suppliedProfile(newSettings()),
  timezoneConfirmed: true,
  additionalPrepConfirmed: true,
  returnMinutes: 20,
  postWorkMinutes: 30,
  lateBed: "00:30",
  lateWake: "08:00",
  restBed: "23:00",
  restWake: "07:00",
  origins: {
    timezone: "entered",
    arrivalBuffer: "entered",
    sleepTarget: "entered",
    latency: "entered",
    windDown: "entered",
    outboundMin: "entered",
    outboundMax: "entered",
    combined: "entered",
  },
  ...patch,
});
const duty = (
  date: string,
  category: RotaEntry["category"] = "Early",
  patch: Partial<RotaEntry> = {},
): RotaEntry => ({
  id: `${date}-${category}`,
  date,
  duty: "0007",
  category,
  status: "Work",
  start: `${date}T${category === "Early" ? "06:00" : "14:08"}`,
  end: `${date}T${category === "Early" ? "14:18" : "22:26"}`,
  timezone: tz,
  overtimeMinutes: 0,
  location: "",
  notes: "",
  breakMinutes: null,
  paidMinutes: null,
  ...patch,
});
const rest = (
  date: string,
  status: RotaEntry["status"] = "Rest",
): RotaEntry => ({
  ...duty(date),
  id: `${date}-${status}`,
  status,
  start: null,
  end: null,
});
const clock = (local: string): Clock => ({ now: () => zonedEpoch(local, tz) });
const task = (patch: Partial<Task> = {}): Task => ({
  id: "ironing",
  title: "Iron clothes",
  kind: "flexible",
  minutes: 90,
  earliest: "2032-08-13T08:00",
  deadline: "2032-08-13T20:00",
  windowStart: "08:00",
  windowEnd: "20:00",
  priority: 1,
  recurrence: "none",
  location: "",
  travelMinutes: 0,
  movable: true,
  splittable: false,
  locked: false,
  scheduledStart: null,
  state: "pending",
  ...patch,
});
const timeOf = (plan: ReturnType<typeof planShift>, kind: string) => {
  const event = plan.events.find((e) => e.kind === kind);
  return event ? localAt(event.at, tz) : null;
};

describe("deterministic shift plans", () => {
  it("B: uses a synthetic early example and calculates a full wind-down interval", () => {
    const entry = duty("2032-08-15");
    const plan = planShift(entry, settings(), [entry]);
    expect(timeOf(plan, "prepare")).toBe("2032-08-15T05:00");
    expect(timeOf(plan, "wake")).toBe("2032-08-15T05:00");
    expect(timeOf(plan, "departure")).toBe("2032-08-15T05:30");
    expect(timeOf(plan, "arrival")).toBe("2032-08-15T05:50");
    expect(timeOf(plan, "workStart")).toBe("2032-08-15T06:00");
    expect(timeOf(plan, "sleepStart")).toBe("2032-08-14T22:00");
    expect(timeOf(plan, "bedtime")).toBe("2032-08-14T21:30");
    // A full 60-minute wind-down before 21:30 starts at 20:30.
    expect(timeOf(plan, "windDown")).toBe("2032-08-14T20:30");
    expect(plan.provisional).toBe(false);
    expect(plan.events.every((e) => e.why.length > 0)).toBe(true);
  });

  it("C: adds breakfast once, changes preparation and waking, and preserves departure", () => {
    const s = settings();
    s.routines.push({
      id: "breakfast",
      name: "Breakfast",
      includes: ["breakfast"],
      minutes: 15,
      essential: true,
    });
    const entry = duty("2032-08-15");
    const plan = planShift(entry, s, [entry]);
    expect(timeOf(plan, "prepare")).toBe("2032-08-15T04:45");
    expect(timeOf(plan, "wake")).toBe("2032-08-15T04:45");
    expect(timeOf(plan, "departure")).toBe("2032-08-15T05:30");
    expect(essentialPreparation(s).minutes).toBe(45);
  });

  it("D: late preparation never supplies a fabricated early-afternoon wake recommendation", () => {
    const entry = duty("2032-08-10", "Late");
    const plan = planShift(
      entry,
      settings({ lateWake: null, restWake: null }),
      [entry],
    );
    expect(timeOf(plan, "prepare")).toBe("2032-08-10T13:08");
    expect(timeOf(plan, "departure")).toBe("2032-08-10T13:38");
    expect(timeOf(plan, "arrival")).toBe("2032-08-10T13:58");
    expect(timeOf(plan, "wake")).toBeNull();
    expect(timeOf(plan, "bedtime")).toBeNull();
    expect(plan.missing.join(" ")).toContain("wake time is still needed");
    const preferred = planShift(entry, settings(), [entry]);
    expect(timeOf(preferred, "wake")).toBe("2032-08-10T08:00");
  });

  it("F: reports an infeasible turnaround and retains all seven hours in the proposed target", () => {
    const late = duty("2032-08-14", "Late"),
      early = duty("2032-08-15");
    const plan = planShift(early, settings(), [late, early]);
    expect(plan.availableSleepMinutes).toBe(254);
    expect(plan.conflicts.join(" ")).toContain(
      "420-minute sleep target cannot fit",
    );
    expect(timeOf(plan, "sleepStart")).toBe("2032-08-14T22:00");
    expect(plan.provisional).toBe(true);
  });

  it("flags prior return travel and recovery overlapping wind-down even when the full sleep target fits", () => {
    const entry = duty("2026-10-10", "Late");
    const previous = duty("2026-10-09", "Custom", {
      start: "2026-10-09T12:00",
      end: "2026-10-09T20:50",
    });
    const s = settings({ beforeLateBed: "22:00", beforeLateWake: "07:00" });
    const plan = planShift(entry, s, [previous, entry]);
    expect(plan.availableSleepMinutes).toBeGreaterThan(s.sleepTarget!);
    expect(plan.conflicts.join(" ")).toContain(
      "Return travel and necessary post-work activities after the previous duty run into",
    );
    expect(timeOf(plan, "windDown")).toBe("2026-10-09T21:00");
    expect(timeOf(plan, "bedtime")).toBe("2026-10-09T22:00");
    expect(timeOf(plan, "wake")).toBe("2026-10-10T07:00");
  });

  it("permits prior recovery ending exactly at wind-down and does not invent unknown recovery durations", () => {
    const entry = duty("2026-10-10", "Late");
    const previous = duty("2026-10-09", "Custom", {
      start: "2026-10-09T12:00",
      end: "2026-10-09T20:50",
    });
    for (const patch of [
      { returnMinutes: 5, postWorkMinutes: 5 },
      { returnMinutes: null, postWorkMinutes: 30 },
      { returnMinutes: 20, postWorkMinutes: null },
    ]) {
      const plan = planShift(
        entry,
        settings({ beforeLateBed: "22:00", beforeLateWake: "07:00", ...patch }),
        [previous, entry],
      );
      expect(plan.conflicts.join(" ")).not.toContain(
        "Return travel and necessary post-work activities after the previous duty run into",
      );
      if (patch.returnMinutes === null || patch.postWorkMinutes === null)
        expect(plan.missing.length).toBeGreaterThan(0);
      expect(timeOf(plan, "windDown")).toBe("2026-10-09T21:00");
    }
  });

  it("H: extends a scheduled finish once, while an actual finish supersedes overtime", () => {
    const late = duty("2032-08-14", "Late", { overtimeMinutes: 60 });
    const early = duty("2032-08-15");
    expect(localAt(effectiveEnd(late)!, tz)).toBe("2032-08-14T23:26");
    expect(
      planShift(early, settings(), [late, early]).availableSleepMinutes,
    ).toBe(194);
    const actual = { ...late, actualEnd: "2032-08-14T22:56" };
    expect(localAt(effectiveEnd(actual)!, tz)).toBe("2032-08-14T22:56");
    expect(
      planShift(early, settings(), [actual, early]).availableSleepMinutes,
    ).toBe(224);
    expect((workBounds(late)!.end - workBounds(late)!.start) / MINUTE).toBe(
      558,
    );
  });

  it("preserves unanswered durations and does not replace unknown commute/preparation with zero", () => {
    const s = settings({
      outboundMax: null,
      returnMinutes: null,
      postWorkMinutes: null,
      additionalPrepConfirmed: false,
    });
    s.routines[0].minutes = null;
    const entry = duty("2032-08-15");
    const plan = planShift(entry, s, [entry]);
    expect(timeOf(plan, "departure")).toBeNull();
    expect(timeOf(plan, "prepare")).toBeNull();
    expect(timeOf(plan, "wake")).toBeNull();
    expect(plan.availableSleepMinutes).toBeNull();
    expect(s.returnMinutes).toBeNull();
    expect(s.routines[0].minutes).toBeNull();
    expect(plan.provisional).toBe(true);
  });

  it("treats suggested starting durations as provisional until explicitly accepted", () => {
    const s = settings({
      origins: { ...newSettings().origins, outboundMax: "entered" },
    });
    const entry = duty("2032-08-15");
    const plan = planShift(entry, s, [entry]);
    expect(plan.provisional).toBe(true);
    expect(plan.missing.join(" ")).toContain(
      "suggested starting value for arrival buffer",
    );
    expect(plan.missing.join(" ")).toContain(
      "suggested starting value for sleep target",
    );
    expect(timeOf(plan, "prepare")).toBe("2032-08-15T05:00");
    expect(
      planTasks([task()], [rest("2032-08-13")], s, clock("2032-08-13T07:00"))[0]
        .start,
    ).toBeNull();
  });

  it("compares a usual late early-shift bedtime without treating it as fixed or shortening the target", () => {
    const entry = duty("2032-08-15");
    const incompatible = planShift(entry, settings({ earlyBed: "23:00" }), [
      entry,
    ]);
    expect(timeOf(incompatible, "bedtime")).toBe("2032-08-14T21:30");
    expect(timeOf(incompatible, "sleepStart")).toBe("2032-08-14T22:00");
    expect(incompatible.conflicts.join(" ")).toContain(
      "allows only 330 minutes",
    );
    expect(incompatible.conflicts.join(" ")).toContain(
      "target has not been shortened",
    );
    expect(incompatible.provisional).toBe(true);
    const earlier = planShift(entry, settings({ earlyBed: "21:00" }), [entry]);
    expect(earlier.conflicts).toEqual([]);
    expect(earlier.events.find((e) => e.kind === "bedtime")!.why).toContain(
      "450 minutes estimated sleep opportunity",
    );
    expect(timeOf(earlier, "bedtime")).toBe("2032-08-14T21:30");
  });

  it("withholds total preparation when activities overlap rather than double-counting a combined routine", () => {
    const s = settings();
    s.routines.push({
      id: "coffee-again",
      name: "Coffee",
      minutes: 10,
      essential: true,
      includes: ["COFFEE"],
    });
    expect(essentialPreparation(s).minutes).toBeNull();
    expect(essentialPreparation(s).missing.join(" ")).toContain(
      "cannot be counted twice",
    );
  });

  it("shows work and fixed-appointment conflicts without moving the commitment or shortening sleep", () => {
    const entry = duty("2032-08-15");
    const second = duty("2032-08-15", "Late", { start: "2032-08-15T13:00" });
    const appointment = task({
      kind: "fixed",
      scheduledStart: "2032-08-14T22:30",
      earliest: "2032-08-14T22:30",
      deadline: "2032-08-14T23:59",
    });
    const plan = planShift(entry, settings(), [entry, second], [appointment]);
    expect(plan.conflicts.join(" ")).toContain("Work overlaps");
    expect(plan.conflicts.join(" ")).toContain("Fixed commitment");
    expect(timeOf(plan, "wake")).toBe("2032-08-15T05:00");
    expect(appointment.scheduledStart).toBe("2032-08-14T22:30");
  });

  it("flags recurring fixed commitments against work, preparation and travel on each applicable duty", () => {
    const entry = duty("2032-08-15");
    const dailyResponsibility = task({
      id: "school-run",
      title: "School responsibility",
      kind: "fixed",
      recurrence: "daily",
      scheduledStart: "2032-08-13T05:15",
      earliest: "2032-08-13T05:15",
      deadline: "2032-08-20T09:00",
      minutes: 60,
    });
    const plan = planShift(entry, settings(), [entry], [dailyResponsibility]);
    expect(plan.conflicts.join(" ")).toContain("essential preparation");
    expect(plan.conflicts.join(" ")).toContain("outbound travel");
    expect(plan.conflicts.join(" ")).toContain("work");
    expect(dailyResponsibility.scheduledStart).toBe("2032-08-13T05:15");
  });

  it("keeps duty timestamps in their recorded zone and marks changed preference zones for review", () => {
    const entry = duty("2032-08-15");
    const plan = planShift(entry, settings({ timezone: "America/New_York" }), [
      entry,
    ]);
    expect(timeOf(plan, "workStart")).toBe("2032-08-15T06:00");
    expect(plan.missing.join(" ")).toContain(
      "timezone of your routine preferences",
    );
    expect(plan.provisional).toBe(true);
  });
});

describe("transitions and next actual duty", () => {
  const reference = [
    duty("2032-08-10", "Late"),
    duty("2032-08-11", "Late"),
    duty("2032-08-12", "Late"),
    rest("2032-08-13"),
    rest("2032-08-14"),
    duty("2032-08-15"),
  ];

  it("E: finds both adjustment days and protects recovery after the final late duty", () => {
    const plans = transitions(reference, settings(), clock("2032-08-10T10:00"));
    expect(plans).toHaveLength(1);
    expect(plans[0].adjustmentDates).toEqual(["2032-08-13", "2032-08-14"]);
    expect(plans[0].nextDate).toBe("2032-08-15");
    expect(plans[0].dailySteps![0].wake).toBe("2032-08-13T08:00");
    expect(plans[0].dailySteps![1].wake).toBe("2032-08-14T07:30");
    expect(plans[0].advice.join(" ")).toContain(
      "do not force an unusually early wake",
    );
  });

  it("withholds a precise transition timetable when normal bedtime or recovery inputs are missing", () => {
    const plan = transitions(
      reference,
      settings({ lateBed: null, returnMinutes: null, postWorkMinutes: null }),
      clock("2032-08-10T10:00"),
    )[0];
    expect(plan.dailySteps).toBeUndefined();
    expect(plan.provisional).toBe(true);
    expect(plan.missing.join(" ")).toContain("Usual late-shift bedtime");
    expect(plan.missing.join(" ")).toContain("Return commute");
  });

  it("withholds exact steps if stored duties and current routine settings use different zones", () => {
    const plan = transitions(
      reference,
      settings({ timezone: "America/New_York" }),
      clock("2032-08-10T10:00"),
    )[0];
    expect(plan.dailySteps).toBeUndefined();
    expect(plan.missing.join(" ")).toContain("different timezones");
  });

  it("keeps long-range transition dates visible without detailed distant timetables", () => {
    const entries = [
      duty("2032-09-01", "Late"),
      rest("2032-09-02"),
      duty("2032-09-03"),
    ];
    const plan = transitions(entries, settings(), clock("2032-08-10T10:00"))[0];
    expect(plan.nextDate).toBe("2032-09-03");
    expect(plan.dailySteps).toBeUndefined();
    expect(plan.provisional).toBe(true);
  });

  it("L: withholds specialised night coaching and accepts a correctly dated overnight duty", () => {
    const night = duty("2032-08-11", "Night", {
      start: "2032-08-11T22:00",
      end: "2032-08-12T06:00",
    });
    expect((workBounds(night)!.end - workBounds(night)!.start) / MINUTE).toBe(
      480,
    );
    expect(planShift(night, settings(), [night]).missing.join(" ")).toContain(
      "night-shift sleep coaching",
    );
    const plan = transitions(
      [night, duty("2032-08-12")],
      settings(),
      clock("2032-08-10T10:00"),
    )[0];
    expect(plan.dailySteps).toBeUndefined();
    expect(plan.provisional).toBe(true);
  });

  it("uses the injected clock and next recorded workday through confirmed leave and rest", () => {
    const entries = [
      rest("2032-08-13"),
      { ...rest("2032-08-14", "Holiday"), leaveApproval: "confirmed" as const },
      duty("2032-08-15"),
    ];
    expect(nextWork(entries, clock("2032-08-13T12:00"), tz)?.date).toBe(
      "2032-08-15",
    );
    expect(nextWork(entries, clock("2032-08-15T07:00"), tz)).toBeUndefined();
    expect(
      nextWork(
        entries.map((e) =>
          e.status === "Work" ? { ...e, status: "Holiday" as const } : e,
        ),
        clock("2032-08-13T12:00"),
        tz,
      ),
    ).toBeUndefined();
  });

  it("recognises return to the same shift category after confirmed holiday without inventing adjustment steps", () => {
    const holiday = {
      ...rest("2032-08-13", "Holiday"),
      leaveApproval: "confirmed" as const,
    };
    const entries = [
      duty("2032-08-12"),
      holiday,
      rest("2032-08-14"),
      duty("2032-08-15"),
    ];
    const result = transitions(entries, settings(), clock("2032-08-13T08:00"));
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("Early");
    expect(result[0].to).toBe("Early");
    expect(result[0].nextDate).toBe("2032-08-15");
    expect(result[0].dailySteps).toBeUndefined();
    expect(result[0].advice.join(" ")).toContain(
      "return from confirmed holiday",
    );
    expect(result[0].advice.join(" ")).toContain(
      "travel and essential preparation",
    );
    expect(result[0].provisional).toBe(false);
    expect(
      transitions(
        entries,
        settings({ earlyBed: "23:00" }),
        clock("2032-08-13T08:00"),
      )[0].provisional,
    ).toBe(true);
    const gap = transitions(
      entries.filter((e) => e.date !== "2032-08-14"),
      settings(),
      clock("2032-08-13T08:00"),
    )[0];
    expect(gap.provisional).toBe(true);
    expect(gap.missing.join(" ")).toContain(
      "Rota status on 2032-08-14 is unknown",
    );
  });

  it("never describes requested holiday as an approved return", () => {
    const requested = {
      ...rest("2032-08-13", "Holiday"),
      leaveApproval: "requested" as const,
    };
    expect(
      transitions(
        [duty("2032-08-12"), requested, rest("2032-08-14"), duty("2032-08-15")],
        settings(),
        clock("2032-08-13T08:00"),
      ),
    ).toEqual([]);
    const changedCategory = transitions(
      [
        duty("2032-08-12"),
        requested,
        rest("2032-08-14"),
        duty("2032-08-15", "Late"),
      ],
      settings(),
      clock("2032-08-13T08:00"),
    )[0];
    expect(changedCategory.missing.join(" ")).toContain(
      "requested, not confirmed",
    );
    expect(changedCategory.advice.join(" ")).not.toContain(
      "return from confirmed holiday",
    );
    expect(changedCategory.provisional).toBe(true);
  });
});

describe("protected task placement", () => {
  const c = clock("2032-08-13T07:00");

  it("K: retains a fixed haircut and moves flexible ironing within its entered window", () => {
    const haircut = task({
      id: "haircut",
      title: "Haircut",
      kind: "fixed",
      minutes: 60,
      travelMinutes: 15,
      scheduledStart: "2032-08-13T09:00",
    });
    const entries = [rest("2032-08-13")];
    const original = JSON.stringify([haircut, task()]);
    const plans = planTasks([task(), haircut], entries, settings(), c);
    expect(localAt(plans.find((p) => p.taskId === "haircut")!.start!, tz)).toBe(
      "2032-08-13T09:00",
    );
    expect(localAt(plans.find((p) => p.taskId === "ironing")!.start!, tz)).toBe(
      "2032-08-13T10:00",
    );
    expect(JSON.stringify([haircut, task()])).toBe(original);
  });

  it("protects rest-day sleep, free time and a full post-late recovery even with an early rest preference", () => {
    const entries = [duty("2032-08-12", "Late"), rest("2032-08-13")];
    const morning = task({
      minutes: 60,
      earliest: "2032-08-13T05:00",
      deadline: "2032-08-13T08:00",
      windowStart: "05:00",
      windowEnd: "08:00",
    });
    const plan = planTasks(
      [morning],
      entries,
      settings({ restWake: "05:00" }),
      clock("2032-08-13T05:00"),
    )[0];
    expect(plan.start).toBeNull();
    const freeTime = task({
      earliest: "2032-08-13T16:00",
      deadline: "2032-08-13T18:00",
      windowStart: "16:00",
      windowEnd: "18:00",
      minutes: 30,
    });
    expect(
      planTasks([freeTime], [rest("2032-08-13")], settings(), c)[0].start,
    ).toBeNull();
  });

  it("protects the later wake in a gradual transition plan on its second rest day", () => {
    const entries = [
      duty("2032-08-12", "Late"),
      rest("2032-08-13"),
      rest("2032-08-14"),
      duty("2032-08-15"),
    ];
    const chore = task({
      minutes: 30,
      earliest: "2032-08-14T07:00",
      deadline: "2032-08-14T07:30",
      windowStart: "07:00",
      windowEnd: "07:30",
    });
    expect(
      planTasks([chore], entries, settings(), clock("2032-08-13T12:00"))[0]
        .start,
    ).toBeNull();
  });

  it("protects an entered later post-late bedtime rather than reserving only the earliest possible sleep", () => {
    const entries = [duty("2032-08-12", "Late"), rest("2032-08-13")];
    const chore = task({
      minutes: 30,
      earliest: "2032-08-13T08:00",
      deadline: "2032-08-13T09:00",
      windowStart: "08:00",
      windowEnd: "09:00",
    });
    expect(
      planTasks([chore], entries, settings({ lateBed: "02:00" }), c)[0].start,
    ).toBeNull();
  });

  it("protects separate split-duty work periods and their travel without duplicating overtime", () => {
    const morning = duty("2032-08-13", "Early", {
      start: "2032-08-13T06:00",
      end: "2032-08-13T10:00",
    });
    const afternoon = duty("2032-08-13", "Late", {
      id: "second-part",
      start: "2032-08-13T14:00",
      end: "2032-08-13T18:00",
      overtimeMinutes: 30,
    });
    const chore = task({
      minutes: 30,
      earliest: "2032-08-13T18:10",
      deadline: "2032-08-13T18:40",
      windowStart: "18:10",
      windowEnd: "18:40",
    });
    expect(localAt(effectiveEnd(afternoon)!, tz)).toBe("2032-08-13T18:30");
    expect(
      planTasks(
        [chore],
        [morning, afternoon],
        settings(),
        clock("2032-08-13T10:00"),
      )[0].start,
    ).toBeNull();
  });

  it("uses known free evening time after recovery activities without reserving every minute until a later bedtime", () => {
    const earlyFinishingLate = duty("2032-08-13", "Late", {
      end: "2032-08-13T18:00",
    });
    const chore = task({
      minutes: 30,
      earliest: "2032-08-13T19:00",
      deadline: "2032-08-13T20:00",
      windowStart: "19:00",
      windowEnd: "20:00",
    });
    const placement = planTasks(
      [chore],
      [earlyFinishingLate, rest("2032-08-14")],
      settings(),
      clock("2032-08-13T19:00"),
    )[0];
    expect(localAt(placement.start!, tz)).toBe("2032-08-13T19:00");
  });

  it("leaves a fixed appointment in place and visibly flags its sleep conflict", () => {
    const appointment = task({
      kind: "fixed",
      scheduledStart: "2032-08-13T06:00",
      earliest: "2032-08-13T06:00",
      minutes: 30,
    });
    const plan = planTasks(
      [appointment],
      [rest("2032-08-13")],
      settings(),
      c,
    )[0];
    expect(localAt(plan.start!, tz)).toBe("2032-08-13T06:00");
    expect(plan.conflict).toContain("sleep");
  });

  it("places essential tasks before optional tasks and does not fill sleep when time runs out", () => {
    const essential = task({
      id: "pack",
      kind: "essential",
      minutes: 60,
      earliest: "2032-08-13T08:00",
      deadline: "2032-08-13T09:00",
      windowEnd: "09:00",
    });
    const optional = {
      ...essential,
      id: "game",
      kind: "optional" as const,
      priority: 10,
    };
    const plans = planTasks(
      [optional, essential],
      [rest("2032-08-13")],
      settings(),
      c,
    );
    expect(plans.find((p) => p.taskId === "pack")!.start).not.toBeNull();
    expect(plans.find((p) => p.taskId === "game")!.start).toBeNull();
  });

  it("handles splitting only when allowed and reserves every part before the next task", () => {
    const fixed = task({
      id: "appointment",
      kind: "fixed",
      scheduledStart: "2032-08-13T09:00",
      minutes: 60,
    });
    const split = task({
      minutes: 120,
      splittable: true,
      deadline: "2032-08-13T11:00",
      windowEnd: "11:00",
    });
    const plans = planTasks(
      [split, fixed],
      [rest("2032-08-13")],
      settings(),
      c,
    );
    const result = plans.find((p) => p.taskId === split.id)!;
    expect(result.parts).toHaveLength(2);
    expect(
      result.parts!.reduce((n, p) => n + (p.end - p.start) / MINUTE, 0),
    ).toBe(120);
    expect(
      planTasks(
        [{ ...split, splittable: false }, fixed],
        [rest("2032-08-13")],
        settings(),
        c,
      ).find((p) => p.taskId === split.id)!.start,
    ).toBeNull();
  });

  it("does not treat Unknown or missing sleep inputs as confirmed task availability", () => {
    expect(
      planTasks(
        [task()],
        [{ ...rest("2032-08-13", "Holiday"), leaveApproval: "requested" }],
        settings(),
        c,
      )[0].start,
    ).toBeNull();
    expect(
      planTasks([task()], [rest("2032-08-13", "Unknown")], settings(), c)[0]
        .start,
    ).toBeNull();
    const missing = planTasks(
      [task()],
      [rest("2032-08-13")],
      settings({ restBed: null }),
      c,
    )[0];
    expect(missing.start).toBeNull();
    expect(missing.reason).toContain("bedtime");
    expect(
      planTasks(
        [task()],
        [rest("2032-08-13")],
        settings({ timezoneConfirmed: false }),
        c,
      )[0].start,
    ).toBeNull();
  });

  it("keeps a linked preparation task before the next actual departure and reviews a removed duty", () => {
    const entry = duty("2032-08-15");
    const lunch = task({
      id: "lunch",
      kind: "essential",
      minutes: 30,
      linkedShiftId: entry.id,
      earliest: "2032-08-14T18:00",
      deadline: "2032-08-15T12:00",
      windowStart: "18:00",
      windowEnd: "20:00",
    });
    const entries = [rest("2032-08-14"), entry];
    const placed = planTasks(
      [lunch],
      entries,
      settings(),
      clock("2032-08-14T18:00"),
    )[0];
    expect(localAt(placed.start!, tz)).toBe("2032-08-14T18:00");
    expect(placed.end!).toBeLessThan(zonedEpoch("2032-08-15T05:30", tz));
    expect(
      planTasks(
        [lunch],
        [rest("2032-08-14"), { ...entry, status: "Holiday" }],
        settings(),
        clock("2032-08-14T18:00"),
      )[0].reason,
    ).toContain("no longer a workday");
  });

  it("recalculation is stable, creates no extra tasks and schedules daily occurrences independently", () => {
    const recurring = task({
      recurrence: "daily",
      minutes: 30,
      deadline: "2032-08-15T20:00",
    });
    const entries = [
      rest("2032-08-13"),
      rest("2032-08-14"),
      rest("2032-08-15"),
    ];
    const a = planTasks([recurring, recurring], entries, settings(), c);
    expect(a).toHaveLength(3);
    expect(planTasks([recurring], entries, settings(), c)).toEqual(a);
    expect(a.map((p) => p.occurrenceDate)).toEqual([
      "2032-08-13",
      "2032-08-14",
      "2032-08-15",
    ]);
  });

  it("takes one clock snapshot and rounds a new slot forward to a preservable whole minute", () => {
    let reads = 0;
    const injected: Clock = {
      now: () => {
        reads++;
        return zonedEpoch("2032-08-13T08:00:45", tz);
      },
    };
    const placed = planTasks(
      [task({ minutes: 30 })],
      [rest("2032-08-13")],
      settings(),
      injected,
    )[0];
    expect(reads).toBe(1);
    expect(localAt(placed.start!, tz)).toBe("2032-08-13T08:01");
    expect(placed.start! % MINUTE).toBe(0);
  });

  it("shows a passed deadline for a missed recurring task without moving it into sleep", () => {
    const missed = task({
      recurrence: "daily",
      deadline: "2032-08-12T20:00",
      earliest: "2032-08-10T08:00",
    });
    const result = planTasks([missed], [rest("2032-08-13")], settings(), c);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBeNull();
    expect(result[0].reason).toContain("deadline has passed");
  });
});

describe("editable caffeine timing and individual recurring occurrences", () => {
  it("uses the chosen caffeine interval and preserves 360 minutes for older settings", () => {
    const entry = duty("2032-08-15");
    const chosen = planShift(
      entry,
      settings({ caffeine: true, caffeineBeforeBed: 240 }),
      [entry],
    );
    const event = chosen.events.find((e) => e.kind === "caffeine")!;
    expect(localAt(event.at, tz)).toBe("2032-08-14T17:30");
    expect(event.why).toContain("240 minutes");
    expect(
      timeOf(
        planShift(
          entry,
          settings({ caffeine: true, caffeineBeforeBed: undefined }),
          [entry],
        ),
        "caffeine",
      ),
    ).toBe("2032-08-14T15:30");
    const invalid = planShift(
      entry,
      settings({ caffeine: true, caffeineBeforeBed: -1 }),
      [entry],
    );
    expect(invalid.events.some((e) => e.kind === "caffeine")).toBe(false);
    expect(invalid.missing.join(" ")).toContain("Caffeine reminder interval");
  });

  it("skips completed, skipped and deferred occurrences while preserving the next active day", () => {
    const recurring = task({
      recurrence: "daily",
      minutes: 30,
      deadline: "2032-08-16T20:00",
      occurrenceStates: {
        "2032-08-13": "completed",
        "2032-08-14": "skipped",
        "2032-08-15": "deferred",
      },
    });
    const entries = [
      rest("2032-08-13"),
      rest("2032-08-14"),
      rest("2032-08-15"),
      rest("2032-08-16"),
    ];
    const before = JSON.stringify(recurring);
    const results = planTasks(
      [recurring, recurring],
      entries,
      settings(),
      clock("2032-08-13T07:00"),
    );
    expect(results).toHaveLength(1);
    expect(results[0].occurrenceDate).toBe("2032-08-16");
    expect(results[0].start).not.toBeNull();
    expect(JSON.stringify(recurring)).toBe(before);
    expect(
      planTasks(
        [{ ...recurring, state: "completed" }],
        entries,
        settings(),
        clock("2032-08-13T07:00"),
      ),
    ).toEqual([]);
  });

  it("removes only the completed recurring fixed conflict and leaves the following appointment fixed", () => {
    const recurring = task({
      id: "daily-appointment",
      kind: "fixed",
      recurrence: "daily",
      minutes: 60,
      scheduledStart: "2032-08-13T09:00",
      deadline: "2032-08-16T20:00",
      occurrenceStates: { "2032-08-15": "completed" },
    });
    const entry = duty("2032-08-15");
    expect(
      planShift(entry, settings(), [entry], [recurring]).conflicts,
    ).toEqual([]);
    const following = duty("2032-08-16");
    expect(
      planShift(following, settings(), [following], [recurring]).conflicts.join(
        " ",
      ),
    ).toContain("Fixed commitment");
    const fixed = planTasks(
      [recurring],
      [entry, following],
      settings(),
      clock("2032-08-15T07:00"),
    );
    expect(fixed).toHaveLength(1);
    expect(fixed[0].occurrenceDate).toBe("2032-08-16");
    expect(localAt(fixed[0].start!, tz)).toBe("2032-08-16T09:00");
    expect(fixed[0].conflict).toContain("work");
    const weekly = task({
      id: "weekly-booking",
      kind: "fixed",
      recurrence: "weekly",
      scheduledStart: "2032-08-14T09:00",
      deadline: "2032-08-21T20:00",
      minutes: 30,
    });
    const weeklySlots = planTasks(
      [weekly],
      [rest("2032-08-14"), rest("2032-08-21")],
      settings(),
      clock("2032-08-13T07:00"),
    );
    expect(weeklySlots.map((p) => localAt(p.start!, tz))).toEqual([
      "2032-08-14T09:00",
      "2032-08-21T09:00",
    ]);
    const withoutLock = {
      ...weekly,
      scheduledStart: null,
      earliest: "2032-08-14T09:00",
    };
    expect(
      planTasks(
        [withoutLock],
        [rest("2032-08-14"), rest("2032-08-21")],
        settings(),
        clock("2032-08-13T07:00"),
      ).map((p) => localAt(p.start!, tz)),
    ).toEqual(["2032-08-14T09:00", "2032-08-21T09:00"]);
  });

  it("rejects a zero sleep target while allowing zero latency, wind-down and confirmed travel durations", () => {
    const entry = duty("2032-08-15");
    const invalid = planShift(entry, settings({ sleepTarget: 0 }), [entry]);
    expect(
      invalid.events.some((e) =>
        ["sleepStart", "bedtime", "windDown"].includes(e.kind),
      ),
    ).toBe(false);
    expect(invalid.missing.join(" ")).toContain(
      "Sleep target must be greater than zero",
    );
    expect(invalid.provisional).toBe(true);
    expect(
      planTasks(
        [task()],
        [rest("2032-08-13")],
        settings({ sleepTarget: 0 }),
        clock("2032-08-13T07:00"),
      )[0].start,
    ).toBeNull();
    const valid = planShift(
      entry,
      settings({
        latency: 0,
        windDown: 0,
        returnMinutes: 0,
        outboundMin: 0,
        outboundMax: 0,
      }),
      [entry],
    );
    expect(valid.missing).toEqual([]);
    expect(timeOf(valid, "bedtime")).toBe(timeOf(valid, "sleepStart"));
    expect(timeOf(valid, "windDown")).toBe(timeOf(valid, "bedtime"));
  });
});

describe("calendar and workplace timezone correctness", () => {
  it("L: explicitly rejects ambiguous/nonexistent local times unless the user chooses an occurrence", () => {
    expect(() => zonedEpoch("2026-03-29T01:30", tz)).toThrow();
    expect(() => zonedEpoch("2026-03-29T01:30", tz, "later")).toThrow();
    expect(() => zonedEpoch("2026-10-25T01:30", tz)).toThrow();
    expect(
      zonedEpoch("2026-10-25T01:30", tz, "later") -
        zonedEpoch("2026-10-25T01:30", tz, "earlier"),
    ).toBe(60 * MINUTE);
    expect(() => zonedEpoch("2026-10-25T01:30+01:00", tz)).toThrow();
    const ambiguous = duty("2026-10-25", "Custom", {
      start: "2026-10-25T01:30",
      end: "2026-10-25T08:00",
    });
    expect(
      planShift(ambiguous, settings(), [ambiguous]).missing.join(" "),
    ).toContain("daylight-saving");
  });

  it("calculates elapsed time correctly over the autumn clock change and preserves recorded local times", () => {
    const entry = duty("2026-10-25", "Night", {
      start: "2026-10-25T00:00",
      end: "2026-10-25T08:00",
    });
    const bounds = workBounds(entry)!;
    expect((bounds.end - bounds.start) / MINUTE).toBe(540);
    expect(localAt(bounds.start, tz)).toBe("2026-10-25T00:00");
    expect(localAt(bounds.start, "America/New_York")).toBe("2026-10-24T19:00");
    expect(workBounds(entry)).toEqual(bounds);
  });

  it("handles leap days, year boundaries and the injected workplace-local date", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(displayDate("2027-01-01")).toBe("01/01/2027");
    expect(
      dateInZone(
        { now: () => zonedEpoch("2026-12-31T23:30", tz) },
        "Asia/Tokyo",
      ),
    ).toBe("2027-01-01");
    const entry = duty("2027-01-01");
    expect(timeOf(planShift(entry, settings(), [entry]), "windDown")).toBe(
      "2026-12-31T20:30",
    );
  });
});
