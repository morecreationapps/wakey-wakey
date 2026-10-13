import type { SleepLog } from "../model";

export const SLEEP_DIARY_CONSENT_VERSION = "sleep-diary-account-storage-v1";
export const SLEEP_DIARY_PRIVACY_URL =
  "https://morecreationapps.github.io/wakey-wakey/privacy.html";
export const SLEEP_DIARY_CONSENT_TEXT =
  "I consent to saving this self-reported sleep and restfulness check-in to my account in cloud storage provided by Supabase.";

/** A fresh affirmative form choice is required; imported metadata is not a choice. */
export function recordSleepDiaryConsent(
  consented: boolean,
  now: number,
): NonNullable<SleepLog["consent"]> {
  if (consented !== true)
    throw new Error(
      "Choose the consent checkbox before saving an optional sleep check-in.",
    );
  if (!Number.isFinite(now))
    throw new Error("Unable to record the consent time.");
  return {
    version: SLEEP_DIARY_CONSENT_VERSION,
    recordedAt: new Date(now).toISOString(),
  };
}
