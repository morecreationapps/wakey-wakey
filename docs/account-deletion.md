# Account deletion

The Settings **Delete my account** card is separate from **Reset my account planner**. The latter keeps login; full deletion removes login and all account-owned cloud planner records.

The user confirms their current password and types `DELETE`. Reauthentication uses an isolated non-persisting Supabase client, not the displayed planner's session. Passwords go only to Supabase Auth. A temporary signed password token goes to `wakey-delete-account`; no password, email or target user ID is in that deletion request. The client also checks that Auth returned the same owner and that the visible account did not switch during reauthentication.

The Edge handler verifies the signature/provider identity and password-only authentication, then invokes `planner_assert_account_deletion` to verify the current server-side session. Password AMR must be no older than five minutes. Recovery, signup-code, anonymous and revoked sessions fail closed. The assertion does not require a planner snapshot or successful administrator migration, so a user can delete an account even before setup is finished. Only the verified Auth identity supplies the deletion target.

The server revokes all refresh sessions and calls server-only `auth.admin.deleteUser(id, false)` for hard deletion. Existing foreign keys cascade snapshots, private roles, migration grants, write limits and reminder devices/delivery records. The new migration installs a trigger that deletes only the deleted user's email-keyed legacy migration reservation in the same Auth deletion transaction. Provider security/email logs/backups follow separate retention policies; independently exported files cannot be recalled.

After a confirmed response the client deactivates its planner, cancels local notifications, waits for pending account operations and purges only this owner's account-cache/legacy/recovery keys. A verified migration receipt also permits removal of the exact matching legacy source; changed or unowned legacy data is retained. The client then clears the local login and returns to the login screen. A local storage failure is reported explicitly; it cannot undo server deletion. Other device copies cannot open with a deleted Auth identity and are removed only where the client has device access. The device must reconnect for server account state to be observed.

## Prepared deployment

This source does not establish a live deployed endpoint. Apply the CLI-generated `supabase/migrations/20261012231246_account_deletion.sql`, then deploy this function only after approval of the secured deletion implementation. The entrypoint uses the project's built-in server environment credentials; no new secret should be pasted into the frontend or repository.

`supabase/config.toml` sets `verify_jwt=false` for this function because current asymmetric Auth JWTs require the function's own validation. Keep all handler/getUser/getClaims/live-session checks. Disabling the gateway without those checks would create an unsafe endpoint. No anonymous user may delete an account.

Generate the single-file dashboard deployment artifact with:

```sh
node scripts/bundle-account-deletion.mjs
```

The ignored output is `supabase/functions/wakey-delete-account/deploy/index.ts`. For CLI deployment, discover the installed CLI's function-deploy flags first. Read back the deployed function/authentication setting and RPC/trigger privileges. Exercise success only with a deliberately created disposable account and direct human authorisation; never delete the founder's or a customer's real account as a test.

## Verification performed

Focused tests exercise typed confirmation, active-account races, same-owner reauthentication, failed temporary-session cleanup, strict server request shape, recent authentication, server-only targeting, origin restrictions, session revocation order and safe error suppression. Actual PostgreSQL/PGlite executes the new migration with the account-security schema to check recent/stale/revoked sessions, helper privileges and transactionally scoped owner deletion/cascades/reservation cleanup. Owner-cache tests check queued writes, neighbouring-account preservation, migration receipt matching and post-deletion fences. These fixtures do not establish real hosted Auth deletion, email service behaviour or a signed physical-device flow.

References checked on 13 October 2026: [Apple account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion), [Supabase deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser), [signed AMR fields](https://supabase.com/docs/guides/auth/jwt-fields), [active sessions](https://supabase.com/docs/guides/auth/sessions). Supabase's 12 October TLS deprecation removes CBC-mode ciphers no earlier than 10 November and leaves TLS 1.3 unchanged; use current OS networking.
