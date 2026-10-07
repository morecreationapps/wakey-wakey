# Acceptance and verification record

This is a development-preview record. Source checks, mocked platform tests, exported bundles, simulator runtime and physical-device verification are separate evidence.

## Baseline evidence

The original implementation was checked on 7 October 2026:

| Check                         | Recorded result                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                    | Passed without diagnostics                                                                                                                                                                                            |
| Automated suite               | 92 tests passed: 41 planner, 26 data, 25 platform/reminder tests                                                                                                                                                      |
| Expo compatibility            | `expo install --check` passed                                                                                                                                                                                         |
| Bundle exports                | Web, iOS and Android exports passed                                                                                                                                                                                   |
| Browser interface             | Exercised saved onboarding/reload, provisional inputs, arithmetic timelines, transitions, distinct calendar statuses, task creation/Undo, duplicate import review, unsupported web reminders, mobile and dark layouts |
| iOS simulator                 | Partial: Expo Go opened onboarding and saved through the Sleep setup stage; read-only inspection verified a valid SQLite snapshot and database integrity. Completion/relaunch was not verified                        |
| Physical devices/store builds | Outstanding; no signed store build or physical notification-delivery evidence                                                                                                                                         |

## Clean public-checkout validation

After replacing personal example dates/codes with synthetic fixtures and guarding the local-profile copy when the seed is empty, this checkout was checked on 7 October 2026:

| Command          | Result                                   |
| ---------------- | ---------------------------------------- |
| `pnpm typecheck` | Passed without diagnostics               |
| `pnpm test`      | 3 test files passed; **92 tests passed** |
| `pnpm export:pages` | Fresh web export passed; empty seed and project asset paths verified |
| Static web preview | Generic onboarding opened at `/wakey-wakey/`; icons rendered, onboarding restored through reload, and no captured browser warnings/errors |

The original implementation’s native export and simulator evidence above remains baseline evidence; a clean public web export and hosted verification are recorded separately during deployment. The deployment workflow checks the public checkout before publishing its web assets; inspect that run for the current commit’s result. A passing workflow does not establish native runtime or clinical verification.

## Regression coverage

- **Planner:** preparation/departure/arrival and separate sleep events; additional breakfast; unknown and suggested inputs; combined-routine overlap; infeasible recovery without shortening the target; actual finish/overtime; fixed and recurring conflicts; adjustment days and holiday approval; protected recovery/free time; task splitting/priorities/deadlines; per-occurrence states; caffeine intervals; DST gaps/overlaps, leap dates, year boundaries and an injected clock.
- **Data:** 52-week generation and one/future/all scope; preserved exceptions; requested/confirmed leave distinctions; work/leave overlap; independent validation caches; copying without historical actual finishes; reviewed imports, duplicates, malformed dates/CSV and synthetic mixed rota; UTC calendar export, text escaping and default note omission; formula-safe initial CSV export; schema/type/range/date/timezone/identifier backup validation.
- **Platform:** rolling bounded reminders, stable identifiers, cancellation/replacement and concurrent resync; selected kinds and provisional/conflicting plan guards; recurring appointment occurrences; visible permission denial and unsupported browser status; SQLite adapter serial transactions, retained committed snapshots after failure, corruption/future-version handling and browser quota errors.

Native API and database tests use controlled substitutes where specified. They verify logic and failure handling, not real OS delivery or power-loss durability. The suite does not contain a full automated React screen-flow or accessibility audit.

## Checks still required

1. On physical iOS/Android standalone builds, save, close, disable connectivity, relaunch and restart the device. Verify the actual SQLite data and calculations. Exercise low-storage failure without losing the last committed snapshot.
2. Deny, grant and revoke notification permission. Test foreground/background/lock-screen delivery, actual sound/channel settings, queue replacement after edits/leave and cancellation on deletion. Keep separate-phone-alarm advice visible.
3. Verify native picker/share cancellation, CSV/calendar export, complete JSON backup/restore, malformed restores and deletion. Backups contain user records and no OS permission grant.
4. Exercise every rota editor/pattern/import flow with overnight duties, DST changes, leap/year boundaries, conflicting commitments and timezone changes. Confirm fixed tasks remain fixed and unknown dates never become rest.
5. Complete screen-reader, keyboard, large-font, contrast and small-device checks. Obtain qualified specialist review of educational sleep guidance and transition wording before a validated public/mobile release.
6. For every public deployment, confirm the seed is empty and inspect tracked files and exported assets for personal records, screenshots, backups and credentials. Confirm the hosted preview loads its assets under the configured project path.

The hosted web preview has no browser notifications, guaranteed offline cold start, reliable alarm, account synchronisation or OCR import. Browser localStorage and native SQLite/JSON backups are unencrypted. These limits remain material even when source tests and export checks pass.
