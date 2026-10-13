import { describe, expect, it } from "vitest";
import type { SleepLog } from "../src/model";
import { initialState } from "../src/data/defaults";
import { exportBackup, parseBackup } from "../src/data/backup";
import {
  recordSleepDiaryConsent,
  SLEEP_DIARY_CONSENT_VERSION,
} from "../src/ui/sleepDiaryConsent";

const now = Date.parse("2026-10-13T10:20:30.000Z");
const log: SleepLog = {
  id: "legacy-diary-log",
  date: "2026-10-10",
  bedtime: "2026-10-09T23:30",
  wake: "2026-10-10T07:00",
  estimatedMinutes: 420,
  awakenings: null,
  rested: "Okay",
};

describe("optional sleep diary consent", () => {
  it("rejects a save without an explicit affirmative choice", () => {
    expect(() => recordSleepDiaryConsent(false, now)).toThrow(/checkbox/);
    expect(() =>
      recordSleepDiaryConsent(undefined as unknown as boolean, now),
    ).toThrow(/checkbox/);
  });

  it("records the consent wording version and actual save time after a choice", () => {
    expect(recordSleepDiaryConsent(true, now)).toEqual({
      version: SLEEP_DIARY_CONSENT_VERSION,
      recordedAt: "2026-10-13T10:20:30.000Z",
    });
    expect(() => recordSleepDiaryConsent(true, NaN)).toThrow(/consent time/);
  });

  it("retains old diary entries without inventing consent during backup restore", () => {
    const state = initialState();
    state.sleepLogs = [log];
    const restored = parseBackup(exportBackup(state));
    expect(restored.sleepLogs).toEqual([log]);
    expect(restored.sleepLogs[0]).not.toHaveProperty("consent");
  });

  it("preserves new consent metadata through the existing backup format", () => {
    const state = initialState();
    state.sleepLogs = [{ ...log, consent: recordSleepDiaryConsent(true, now) }];
    expect(parseBackup(exportBackup(state)).sleepLogs).toEqual(state.sleepLogs);
  });

  it.each([
    { version: "", recordedAt: "2026-10-13T10:20:30Z" },
    { version: SLEEP_DIARY_CONSENT_VERSION, recordedAt: "not-a-time" },
    { version: SLEEP_DIARY_CONSENT_VERSION },
    null,
  ])(
    "rejects malformed optional consent records without changing old data",
    (consent) => {
      const state = initialState();
      state.sleepLogs = [log];
      const input = JSON.parse(exportBackup(state));
    input.sleepLogs[0].consent = consent;
      expect(() => parseBackup(JSON.stringify(input))).toThrow(/consent/);
      expect(state.sleepLogs).toEqual([log]);
    },
  );
});
