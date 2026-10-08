# Wakey-Wakey!

Know when you’re working, when to rest, and what to get done before your next shift.

Wakey-Wakey is a React Native, Expo and TypeScript development app for adult shift workers. Its five tabs connect a recorded rota, travel and preparation, sleep opportunities, tasks and settings. Calculations are deterministic and explained in the interface. Planner access requires a verified email-and-password account.

Open the [web preview](https://morecreationapps.github.io/wakey-wakey/).

The GitHub-hosted web app is a **development preview**. Native store builds, physical-device verification, a full accessibility audit and specialist review of sleep guidance remain outstanding. Recording a rota does not approve leave, change an employer’s schedule or assess fitness for duty.

## Run locally

Use Node.js LTS supported by Expo SDK 57 and pnpm. From the repository directory:

```sh
pnpm install --frozen-lockfile
./run-local.sh web
```

Open <http://localhost:8081>. `./run-local.sh phone` starts an Expo Go preview; `./run-local.sh check` runs TypeScript and the automated tests. You can also run `pnpm start`, `pnpm web` or `pnpm check` directly.

The install/bootstrap script creates an empty local-seed module when absent. Public builds contain no personal rota. After creating and verifying an account, new users choose generic early/late templates or start from scratch, then enter and confirm their own work timezone, travel, preparation and sleep preferences. Missing inputs remain visibly provisional. Setup changes save to that user's account, with an account-specific device copy.

The same script restores the supplied app icon and header wordmark from their `assets/*.png.base64` sources, verifies their SHA-256 checksums and writes the PNGs used by Expo. The generated PNGs are ignored; the source encodings preserve the original artwork and transparency exactly.

## Account and email configuration

The app uses Supabase Auth for email-and-password registration, login and purpose-specific confirmation/recovery codes, plus protected Supabase Postgres snapshots for account data. There is no guest, social, phone or magic-link login. Confirmation and recovery tokens cannot open the planner; a verified password session is required. Recovery sets a new password, then returns to normal login.

Follow [the authentication backend and migration guide](docs/auth-backend.md) before enabling accounts. The frontend accepts only `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and the explicit `EXPO_PUBLIC_AUTH_EMAIL_CONFIGURED` readiness flag. Keep that flag false until the real sender, code templates, rate limits and mailbox delivery are checked. Missing configuration displays “Sign-in unavailable” instead of simulating email delivery or allowing planner access. SMTP credentials and privileged backend keys remain on the server.

## What it does

- **Today:** next actual duty and preparation checklist; **Shift transition** schedules tasks and the bedtime routine for the previous calendar day; **Shift Plan** retains the existing sleep, preparation, departure and arrival calculations for that duty.
- **Rota:** day/week/month/year views, editable duties and templates, 52-week patterns, week copying, exceptions and Undo. Rest, unknown dates, requested leave and confirmed leave stay distinct. Overnight work, overtime and actual finish times are separate inputs.
- **Plan:** fixed appointments and essential/flexible/optional tasks, deadlines, windows, travel, recurrence, locks, splitting and per-occurrence completion or skipping.
- **Sleep:** planned opportunities, conflict/missing-input explanations, optional self-reported diary and educational NHS/HSE links. The app does not measure sleep or supply specialist night-shift coaching.
- **Settings:** saved onboarding, light/dark/system themes, account/logout controls, reviewed text/CSV imports, CSV/iCalendar export and validated JSON backup/restore.

Native iOS/Android adapters use SQLite and optional local notifications. Browser notifications are explicitly unsupported. Wake-up notifications are ordinary reminders; use a separate phone alarm. Local permission, file sharing and delivery need real-device checks before a mobile release.

## Build and verify

```sh
pnpm check
pnpm exec expo install --check
pnpm export:web
pnpm export:pages
pnpm exec expo export --platform all
```

The public deployment workflow exports static web assets for GitHub Pages. The native `pnpm ios`/`pnpm android` commands require the respective Xcode/CocoaPods or Android toolchain; they do not submit to a store. See [the acceptance record](docs/acceptance.md) for the checked evidence and its limits, and [the implementation notes](docs/implementation.md) for design decisions.

Pushes to `main` run the Pages workflow on Node 24 and pinned pnpm 11.19.0. Typechecking, tests and a guarded public export must pass before deployment. The Pages export uses `/wakey-wakey/`, rejects private seed data and uploads only `dist`. Local development and native builds retain their normal root paths.

The Pages export places bundled fonts in a flat, visible asset directory because GitHub's archive excludes hidden dependency folders. It verifies referenced assets and gives rewritten JavaScript bundles new filenames for browser cache updates.

## Data and limitations

Rota, settings, templates, patterns, tasks and diary records belong to the authenticated account and synchronise with its protected backend. The backend checks ownership and a verified password session. Account-specific device caches retain pending offline changes, and revision checks refuse stale overwrites. Browser copies and session credentials use localStorage; native planner copies use ordinary SQLite and native session credentials use secure storage. Planner records and exported JSON backups are not encrypted by this implementation. Exports contain user data and should be kept privately. The app has no analytics or AI calls.

Browser storage belongs to the site's origin and browser profile. GitHub project sites on the same `github.io` host share an origin; repository paths and account-prefixed cache keys do not isolate storage from other code on that host. Clearing browser data or using private browsing can remove device copies. Logout hides the planner, isolates account views and cancels account reminders without deleting saved planner records. Legacy localhost data is eligible for transfer only through the trusted administrator reservation/binding and verified one-time migration described in the backend guide; new accounts never inherit it.

Offline planner access is limited to a previously validated, still-valid password session in the running app and that account's device cache. Cold offline sign-in/session restoration is not an authentication bypass. The browser has no service worker for guaranteed offline cold starts and needs hosted assets to load. Task placement is a conservative greedy heuristic with a 14-day horizon. Photo/PDF/OCR import, calendar synchronisation, widgets, wearable integration and reliable OS alarms are deferred. See the implementation notes for the remaining release checks.
