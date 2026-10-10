# Planning alerts

Wakey-Wakey alerts use the dated activities in **Shift Transition** and **Shift Plan**, including active individual tasks. The shared `src/platform/reminders.ts` engine converts the same panel calculations into notification intentions. Dates use each duty's recorded timezone, and displayed dates follow the user's preferences. Generating alerts does not add tasks or change their dates and times.

## Enable and test

1. Log in, complete setup and confirm the work timezone. Save any pending planner changes.
2. Open **Settings → Reminders & permissions → Enable alerts on this device**. Grant the browser or OS notification permission when prompted. Each browser profile, home-screen installation and native device needs its own permission.
3. Choose the reminder types. **Individual preparation tasks** covers ordinary tasks; **Appointments and appointment travel** covers fixed appointments; **Other Shift Plan activities** includes arrival, work, finish, return and target sleep start. Wind-down, bedtime, wake, departure and caffeine have separate switches.
4. Use **Refresh status & schedule**, then **Test notification**. A registered web push test requests a real server push. If push is unavailable or the request fails, the web app offers a foreground test after five seconds. Native tests schedule an ordinary local notification after five seconds. An accepted request or scheduled count does not prove device delivery.

The in-app alert displays the activity, due date/time, **View plans** and **Dismiss alert**. Completing, skipping, deferring, deleting or changing an item updates alerts after the change is saved. Actual conflicts and activities with no valid time do not create a due alert. Unrelated missing inputs do not suppress a valid dated activity. Canonical bedtime/wind-down and equivalent saved tasks are deduplicated, while recurring occurrences and split task parts remain distinct.

## Platform behaviour

| Platform            | App open                                                                                                                                    | App closed                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Website             | In-app due alerts, including browsers without push support. With permission and registration, system push notifications are also available. | The notification service worker receives server Web Push on supported browsers. A page timer alone cannot provide this. |
| Home-screen web app | Same calculations and in-app alerts as the website. Enable permission inside the installed app.                                             | Server Web Push on supported installations. On iPhone/iPad, use a Home Screen app on iOS/iPadOS 16.4 or later.          |
| Native iOS/Android  | In-app alerts plus permitted OS local notifications.                                                                                        | The OS delivers notifications already scheduled on that device; JavaScript does not need to stay running.               |

iPhone/iPad browser tabs need the home-screen installation for Web Push, and permission must follow a user action. See [WebKit's platform guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). Native scheduling uses [Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/); this implementation does not use remote native APNs/FCM pushes.

Native schedules retain the earliest **60 alerts within the next 14 days**. Opening or foregrounding the app, saved edits and active minute refreshes renew this bounded queue. It cannot refill indefinitely while closed. Changes made on another device take effect on a native device when it next synchronises.

The open web app considers **14 days, capped at 1,000 records per device**. For closed-app push, Supabase computes a **rolling 24-hour cache**, also capped at 1,000 records, and renews it at least every 12 hours or when saved data changes. This keeps server computation bounded while alerts continue rolling forward without reopening the app. It derives intentions from the authoritative saved account snapshot; the browser does not supply trusted task content. A minute cron checks due/changed registrations and fans out independently per eligible device, with at most four simultaneous provider requests for that device. Web delivery can arrive up to a minute after the due time, with additional network/provider/OS delays. Push TTL and stale-alert grace are 90 seconds; an older delivery is discarded rather than presenting an obsolete task as due.

Web registrations expire from dispatch eligibility after **30 days without a client resynchronisation**. Reopen the app regularly and refresh its schedule. Long-running tabs also renew their registration through the client heartbeat. There is an eight-enabled-device limit per account. Expired provider subscriptions are disabled and need re-enabling.

These are ordinary notifications. Focus/Do Not Disturb, permission denial, quiet notification settings, battery restrictions and device/browser policies may suppress or delay them. Android timing can be inexact. There is no critical-alert entitlement, verified exact-alarm guarantee or emergency wake-up service. Use a separate phone alarm for waking. The notification service worker does not cache planner pages or provide a guaranteed offline cold start.

## Account isolation and privacy

Opt-in is explicit; opening the app does not request OS permission. Logout/account switching cancels or disables that device's reminders and clears its active notification owner. Ownership checks reject old-account delivery/tap callbacks. Web registrations and delivery claims are stored in private RLS tables with no `anon` or `authenticated` table/RPC access; the Edge handler requires a verified password session before user actions. The dispatcher rechecks account, session, opt-in and snapshot revision before claiming a delivery.

Web notifications disclose their activity title, due date and short message to the receiving device. Web Push payloads are encrypted for that subscription. Provider delivery metadata and lock-screen visibility still depend on the browser/OS. Do not put secrets into task names. Subscription endpoints/keys stay in protected server storage; the device retains routing and deduplication metadata. VAPID private keys and the Vault cron credential never enter frontend assets or backups. Delivery fingerprints are claimed before sending, preventing duplicate retries; an uncertain failed provider request is not automatically replayed. Old delivery claims are pruned after 30 days.

## Operator deployment and support

The Pages workflow deploys the frontend only. Shared reminder-engine changes require rebuilding and separately redeploying the Edge bundle. From an installed source checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
node scripts/bundle-reminders.mjs
```

The generated `supabase/functions/wakey-reminders/deploy/index.ts` is ignored and contains the shared planner engine with pinned Deno/npm dependencies. Apply the reviewed `20261010101751_planning_alerts.sql` migration and its `20261010110152_alert_dispatch_timeout.sql` follow-up through the normal migration workflow. They require the existing account-security schema plus pg_cron, pg_net, pgcrypto and Vault. The initial migration names the Wakey-Wakey project URL; review that target before reuse in another project. It creates protected storage, extends valid reminder choices and installs `wakey-due-alerts` on `* * * * *`. The follow-up raises the HTTP dispatch timeout to 50 seconds, preserving the function's existing permissions and attributes through a guarded definition replacement.

For CLI deployment, first inspect the installed CLI's `--help`. Configure this custom entrypoint in `supabase/config.toml`:

```toml
[functions.wakey-reminders]
verify_jwt = false
entrypoint = "./functions/wakey-reminders/deploy/index.ts"
```

```sh
supabase --help
supabase functions deploy --help
supabase functions deploy wakey-reminders --project-ref zhdoydzgtuskiflnzzxh --no-verify-jwt
```

The same bundle can be supplied through the dashboard or deployment API. `verify_jwt = false` disables the gateway's JWT check so Vault-authenticated cron can call the function. **Keep the handler's own authentication checks:** user actions validate the provider user and `planner_load` password/session guard; dispatch requires the server-only Vault credential. Do not replace this function with an unauthenticated pass-through. Supabase documents [custom entrypoints and gateway configuration](https://supabase.com/docs/guides/functions/function-configuration), [deployment flags](https://supabase.com/docs/reference/cli/supabase-functions-deploy) and [scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

After deployment, check the actual endpoint rejects an unauthenticated user POST with HTTP 401, the cron job is active, advisors remain clear of new client-access warnings, and a user-approved test reaches the intended device. Inspect cron/Edge failures and provider outcome counts without exposing subscription contents or credentials. `scheduled` describes intentions; it is not a delivery receipt.

On 10 October 2026, the migration and Edge Function were deployed, unauthenticated HTTP 401 was verified and the minute cron was active. An actual local test notification was received in Expo Go 57 on the iOS 27 simulator, and iOS/Android bundle exports passed. Closed-browser/home-screen provider delivery and physical standalone iOS/Android delivery remain unverified. Automated tests execute the handler with injected adapters and real PostgreSQL security/lifecycle logic with synthetic provider-extension fixtures; these do not establish physical delivery.
