# Implementation notes

The app uses Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6, Expo SQLite/Notifications and the Temporal polyfill. Exact package versions are recorded in the lockfile. This repository contains generic examples and synthetic test data; a public build starts with an empty rota.

## Data and planning

Native persistence serialises a validated schema 1 snapshot in SQLite. Saves, loads and deletion are queued; a transaction commits a full revision. SQL values are bound parameters. Corrupt snapshots and unsupported future schema versions are retained and reported. Browser persistence uses localStorage. A general future-schema migration framework is not implemented. Undo retains 12 recent in-memory revisions and does not survive restart.

Work times are recorded in an explicit work timezone. Temporal converts them to exact instants for elapsed calculations and DST checks. Nonexistent local times are rejected; repeated times require an explicit earlier/later choice. A single choice currently applies to both duty boundaries, so a duty cannot distinguish earlier and later copies of identical repeated clock endpoints.

The planner subtracts arrival buffer and the entered outbound upper travel estimate from a shift start, then subtracts essential preparation. It derives separate preparation, departure, arrival, bedtime, target sleep start and wind-down events. A combined routine is counted once; overlapping named activities require review. Return travel and recovery are separate inputs. Suggested durations and unconfirmed inputs remain provisional.

For example, a 06:00 shift, 10-minute arrival buffer, 20-minute journey and 30-minute preparation routine imply 05:00 preparation, 05:30 departure and 05:50 arrival. A seven-hour target gives 22:00 target sleep start; 30-minute latency gives 21:30 bedtime; a full 60-minute wind-down starts at 20:30. These are synthetic arithmetic examples, not measured sleep.

Actual finish supersedes a planned overtime extension for recovery; overtime is not added twice. Requested holiday never establishes free time or approved return-to-work guidance. Shift changes and confirmed holiday returns produce transparent review advice. A 30-minute gradual-adjustment heuristic is not a measured circadian model or clinical advice. Exact steps are withheld when recovery preferences are unknown, and specialised night-shift coaching remains unavailable.

Task placement is deterministic and greedy. It reserves fixed commitments, work/travel, essential preparation, full planned sleep/recovery and protected rest-day time before fitting tasks. It may miss an alternative feasible arrangement; users can revise or lock commitments. Its near-term horizon is 14 days. The rest-day personal-time reserve currently starts at 16:00; a fixed commitment can express another time. Completed/skipped recurring occurrences are separate from the series.

## Platform behaviour

Reminders require opt-in, permission and confirmed setup. Automatic refresh follows a successfully saved revision. Stable identifiers and cancellation before replacement prevent duplicate app reminders. A rolling queue considers 14 days and caps at 60 events; reopening or foregrounding renews it. Ordinary notifications remain subject to OS permissions, Focus/sound/battery behaviour. Verified OS alarms, critical alerts, exact-alarm guarantees and indefinite background refill are not implemented. Web reminders report unsupported status.

Text/CSV import requires a reviewed preview, validates dates/overlap/duplicates and does not execute input. Calendar exports omit private notes and sleep records by default; complete JSON backups contain them. Restore validates schema 1 before replacement. CSV formula escaping is an initial-export mitigation, not a universal guarantee after spreadsheet re-saving. Neither storage nor backups are encrypted.

## Development preview and remaining work

The browser is statically hosted and saves to its own origin/profile. Assets still need to load from the host; there is no service worker for guaranteed offline cold starts. There is no application backend, account system, analytics or cloud data synchronisation. GitHub Pages project paths share the host’s browser origin, so they do not provide independent storage security boundaries.

Before a mobile release, verify standalone iOS/Android offline restart, actual notification delivery/denial/cancellation, native file sharing and backup restore on physical devices. Complete screen-reader, keyboard, large-text and device accessibility checks. Sleep guidance and transition wording require qualified specialist review; the educational source links do not establish clinical validation or fitness for duty.

Photo/PDF/OCR input is deferred until it has an editable uncertainty-aware preview and explicit confirmation. Other later work includes calendar synchronisation, widgets, opt-in sharing, wearable integration, travel disruption sources, diary trends and specialist night-shift coaching.
