# Acceptance and verification record

This is a development-preview record. Source checks, mocked platform tests, exported bundles, simulator runtime and physical-device verification are separate evidence.

The baseline tables below predate the account addition. Current authentication, account ownership and controlled-migration checks are recorded separately in [the backend verification guide](auth-backend.md). Passing earlier local-only planner checks does not establish hosted authentication, email delivery or migration of the owner's actual records.

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

| Command             | Result                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | Passed without diagnostics                                                                                                                |
| `pnpm test`         | 3 test files passed; **92 tests passed**                                                                                                  |
| `pnpm export:pages` | Fresh web export passed; empty seed and project asset paths verified                                                                      |
| Static web preview  | Generic onboarding opened at `/wakey-wakey/`; icons rendered, onboarding restored through reload, and no captured browser warnings/errors |

The original implementation’s native export and simulator evidence above remains baseline evidence; a clean public web export and hosted verification are recorded separately during deployment. The deployment workflow checks the public checkout before publishing its web assets; inspect that run for the current commit’s result. A passing workflow does not establish native runtime or clinical verification.

The public export flattens bundled asset paths for the Pages archive, validates referenced asset and JavaScript files, rejects missing or hidden assets and conflicting filenames, and changes the filenames of rewritten bundles to refresh browser caches. Font delivery must also be checked on the live HTTPS site after deployment.

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

The account addition uses Supabase Auth and protected account snapshots; real sender configuration, hosted code/rate-limit checks and the administrator's verified migration must be recorded individually before they are claimed complete. The hosted web preview still has no browser notifications, guaranteed offline cold start, reliable alarm or OCR import. Browser localStorage and native planner SQLite/JSON backups are unencrypted; native session credentials use secure storage. These limits remain material even when source tests and export checks pass.

Current hosted configuration evidence on 7 October 2026: SMTP is saved, sender/domain DNS is verified, confirmation/recovery code templates are saved, code length/expiry are 8 digits/600 seconds, and the password minimum is 12. The dashboard confirms 30 verification and 30 signup/sign-in requests per 5 minutes per IP, 150 refreshes per 5 minutes per IP and 30 auth emails per hour. Site URL read-back passed for `https://morecreationapps.github.io/wakey-wakey/`; the redirect allowlist is empty. User-approved application-schema and trusted-reservation deployment succeeded, including all operator-script assertions. Hosted read-back confirmed the approved reservation, 1 reservation, 0 bound administrators, 0 migration grants and 0 stored snapshots; no personal settings were uploaded. Actual email requests/delivery, rejection/cooldown behaviour, administrator verification/binding and migration remain pending. No source or fixture result substitutes for those remaining live checks.

Hosted database acceptance checks passed: five RLS tables, four authenticated-only invoker RPCs, no direct client snapshot writes, one owner SELECT policy, no client access to trusted setup helpers, and no bindings/grants/snapshots. The inspected automatic-RLS event-trigger helper's direct execution was revoked from PUBLIC/anon/authenticated; read-back and a rolled-back empty public-table probe confirmed the trigger still enforced RLS and the probe was removed. Security advisors returned 0 errors, 0 warnings and 4 informational findings for private RLS tables with intentionally no client policies; performance advisors returned no findings. The retained 8081 snapshot was re-read and still matched the exact 6,773-byte private backup and SHA-256. These checks establish deployed permissions and retained source data, while signed account isolation, real email/code flows and migration remain pending.

Live signup delivery is currently blocked: the Auth endpoint returned HTTP 500 and its server logs showed SMTP 535 rejecting the authentication credentials. Saved SMTP settings and verified DNS have not produced a verified confirmation delivery. Credential repair, real delivered codes, successful verification and migration remain pending. Narrow client regressions cover safe known-mail-failure messages, generic unrelated-server errors and failed signup/recovery retaining their form with no identity or success claim; these source checks do not establish working SMTP.

Final local acceptance evidence: all 167 tests across 6 Vitest files and TypeScript checking passed. The final guarded Pages export passed with 21 flat assets and 2 bundles. Desktop and 320-pixel UI checks passed for login/signup/forgot-password navigation, empty/invalid-email validation without sending email, selected/unselected tab semantics (`aria-selected` true/false) and headings. The original 8081 development server and saved browser storage were preserved. Physical native checks, hosted account flows, delivered email, administrator migration and public release of the authentication addition have not been performed or claimed complete.
