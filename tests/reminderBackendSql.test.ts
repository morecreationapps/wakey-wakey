import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { initialState } from "../src/data/defaults";

// Executes the actual migrations in PostgreSQL. Only provider-owned Auth tables
// and the external Vault/net/Cron extension interfaces are synthetic fixtures.
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const DEVICE = "30000000-0000-4000-8000-000000000001";
const session = (id: string) => id.replace(/^1/, "2");
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-endpoint",
  keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
};
let db: PGlite;
let previousValidator: Record<string, unknown>;
let migration: string;
let timeoutMigration: string;
let dispatcherBeforeTimeout: Record<string, unknown>;
const snapshot = (enabled = true) => {
  const state = initialState();
  state.settings.remindersEnabled = enabled;
  state.settings.reminderCoverageVersion = 1;
  state.settings.reminderKinds = [
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
  ];
  return JSON.stringify(state);
};
async function owner() {
  await db.exec("reset role");
}
async function sqlRole(role: "anon" | "authenticated" | "service_role") {
  await owner();
  await db.exec(`set role ${role}`);
}
async function service(action: string, data: Record<string, unknown> = {}) {
  await sqlRole("service_role");
  try {
    return (
      await db.query<{ result: unknown }>(
        "select public.wakey_reminder_service($1,$2::jsonb) as result",
        [action, JSON.stringify(data)],
      )
    ).rows[0].result;
  } finally {
    await owner();
  }
}
async function seed(id = A, revision = 1, enabled = true) {
  await owner();
  await db.query(
    "insert into public.planner_snapshots(user_id,payload,revision) values($1,$2,$3) on conflict(user_id) do update set payload=excluded.payload,revision=excluded.revision",
    [id, snapshot(enabled), revision],
  );
}
async function subscribe(userId = A, deviceId = DEVICE) {
  return service("subscribe", {
    userId,
    deviceId,
    sessionId: session(userId),
    subscription,
  });
}
function dueSchedule(at = Date.now(), title = "Synthetic activity") {
  return [
    {
      id: "wakey:synthetic",
      title,
      body: "Synthetic date and time",
      kind: "task",
      at,
    },
  ];
}

describe("executed PostgreSQL web reminder permissions and lifecycle", () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,is_anonymous boolean default false,deleted_at timestamptz,banned_until timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb); $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
      grant usage on schema auth to authenticated,anon;
      create schema vault;
      create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,secret text,description text);
      create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
      create function vault.create_secret(new_secret text,new_name text default null,new_description text default '') returns uuid language plpgsql as $$ declare identifier uuid:=gen_random_uuid(); begin insert into vault.secrets values(identifier,new_name,new_secret,new_description); return identifier; end; $$;
      create schema net;
      create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
      create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$ declare identifier bigint; begin insert into net.requests(url,headers,body,timeout_milliseconds) values(url,headers,body,timeout_milliseconds) returning id into identifier; return identifier; end; $$;
      create schema cron;
      create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text);
      create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$ declare identifier bigint; begin insert into cron.job(jobname,schedule,command) values(job_name,schedule,command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into identifier; return identifier; end; $$;
    `);
    const directory = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      let sql = await readFile(new URL(file, directory), "utf8");
      if (file.endsWith("_planning_alerts.sql")) {
        previousValidator = (
          await db.query<{ definition: Record<string, unknown> }>(
            "select to_jsonb(p)-'prosrc'-'prosqlbody' as definition from pg_proc p where p.oid='private.validate_snapshot(text)'::regprocedure",
          )
        ).rows[0].definition;
        migration = sql;
        sql = sql
          .replace(/^create extension if not exists pg_cron;\s*$/m, "")
          .replace(
            /^create extension if not exists pg_net with schema extensions;\s*$/m,
            "",
          );
      }
      if (file.endsWith("_alert_dispatch_timeout.sql")) {
        timeoutMigration = sql;
        dispatcherBeforeTimeout = (
          await db.query<{ definition: Record<string, unknown> }>(
            "select to_jsonb(p)-'prosrc'-'prosqlbody' as definition from pg_proc p where p.oid='private.dispatch_wakey_reminders()'::regprocedure",
          )
        ).rows[0].definition;
      }
      await db.exec(sql);
    }
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,'alice@example.invalid',now(),'synthetic-auth-provider-hash'),($2,'bob@example.invalid',now(),'synthetic-auth-provider-hash')",
      [A, B],
    );
  }, 30_000);
  beforeEach(async () => {
    await owner();
    await db.exec(
      "delete from private.reminder_devices; delete from private.reminder_config; delete from public.planner_snapshots; delete from auth.sessions; delete from net.requests; update auth.users set email_confirmed_at=now(),is_anonymous=false,deleted_at=null,banned_until=null;",
    );
    await db.query(
      "insert into auth.sessions(id,user_id) values($1,$2),($3,$4)",
      [session(A), A, session(B), B],
    );
    await seed(A);
    await seed(B);
  });
  afterAll(async () => {
    await db?.close();
  });

  it("keeps all reminder tables in the private schema with RLS and no client privileges", async () => {
    const tables = await db.query<{
      name: string;
      rls: boolean;
      policies: number;
    }>(`
      select c.relname as name,c.relrowsecurity as rls,(select count(*)::int from pg_policy p where p.polrelid=c.oid) as policies
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('reminder_devices','reminder_deliveries','reminder_config') order by c.relname`);
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every((item) => item.rls)).toBe(true);
    for (const role of ["anon", "authenticated"] as const) {
      const privileges = (
        await db.query<{ allowed: boolean }>(
          "select has_table_privilege($1,'private.reminder_devices','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege($1,'private.reminder_deliveries','SELECT,INSERT,UPDATE,DELETE') or has_table_privilege($1,'private.reminder_config','SELECT,INSERT,UPDATE,DELETE') as allowed",
          [role],
        )
      ).rows[0].allowed;
      expect(privileges).toBe(false);
      await sqlRole(role);
      await expect(
        db.query("select * from private.reminder_devices"),
      ).rejects.toHaveProperty("code", "42501");
      await owner();
    }
  });
  it("exposes the elevated RPC exclusively to service_role and keeps cron dispatcher inaccessible", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const privileges = (
        await db.query<{ service: boolean; dispatch: boolean }>(
          "select has_function_privilege($1,'public.wakey_reminder_service(text,jsonb)','EXECUTE') as service,has_function_privilege($1,'private.dispatch_wakey_reminders()','EXECUTE') as dispatch",
          [role],
        )
      ).rows[0];
      expect(privileges).toEqual({ service: false, dispatch: false });
      await sqlRole(role);
      await expect(
        db.query("select public.wakey_reminder_service('config')"),
      ).rejects.toHaveProperty("code", "42501");
      await owner();
    }
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select has_function_privilege('service_role','public.wakey_reminder_service(text,jsonb)','EXECUTE') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(true);
    const attrs = (
      await db.query<{ secure: boolean; config: string[] }>(
        "select prosecdef as secure,proconfig as config from pg_proc where oid='public.wakey_reminder_service(text,jsonb)'::regprocedure",
      )
    ).rows[0];
    expect(attrs.secure).toBe(true);
    expect(attrs.config).toContain('search_path=""');
  });
  it("extends only the dispatch HTTP timeout while preserving the function signature, attributes and grants", async () => {
    const after = (
      await db.query<{ definition: Record<string, unknown> }>(
        "select to_jsonb(p)-'prosrc'-'prosqlbody' as definition from pg_proc p where p.oid='private.dispatch_wakey_reminders()'::regprocedure",
      )
    ).rows[0].definition;
    expect(after).toEqual(dispatcherBeforeTimeout);
    await subscribe();
    await db.query("select private.dispatch_wakey_reminders()");
    const request = (
      await db.query<{ timeout: number }>(
        "select timeout_milliseconds as timeout from net.requests",
      )
    ).rows[0];
    expect(request.timeout).toBe(50_000);
    expect(timeoutMigration).toContain("pg_get_functiondef");
  });
  it("rejects an unexpected dispatcher definition instead of silently rewriting unrelated configuration", async () => {
    const original = (
      await db.query<{ definition: string }>(
        "select pg_get_functiondef('private.dispatch_wakey_reminders()'::regprocedure) as definition",
      )
    ).rows[0].definition;
    try {
      await db.exec(
        original.replace(
          "timeout_milliseconds:=50000",
          "timeout_milliseconds:=42000",
        ),
      );
      await expect(db.exec(timeoutMigration)).rejects.toThrow(
        "Expected one original reminder dispatcher timeout",
      );
      await db.exec("rollback");
      const current = (
        await db.query<{ definition: string }>(
          "select pg_get_functiondef('private.dispatch_wakey_reminders()'::regprocedure) as definition",
        )
      ).rows[0].definition;
      expect(current).toContain("timeout_milliseconds:=42000");
    } finally {
      await db.exec("rollback");
      await db.exec(original);
    }
  });
  it("changes only valid reminder types and preserves the existing snapshot validator ACL and attributes", async () => {
    const after = (
      await db.query<{ definition: Record<string, unknown> }>(
        "select to_jsonb(p)-'prosrc'-'prosqlbody' as definition from pg_proc p where p.oid='private.validate_snapshot(text)'::regprocedure",
      )
    ).rows[0].definition;
    expect(after).toEqual(previousValidator);
    await expect(
      db.query("select private.validate_snapshot($1)", [snapshot()]),
    ).resolves.toBeDefined();
    const invalid = JSON.parse(snapshot());
    invalid.settings.reminderKinds.push("unknown");
    await expect(
      db.query("select private.validate_snapshot($1)", [
        JSON.stringify(invalid),
      ]),
    ).rejects.toHaveProperty("code", "22023");
  });
  it("requires a verified, active owner session and limits enabled notification devices", async () => {
    await expect(
      service("subscribe", {
        userId: A,
        deviceId: DEVICE,
        sessionId: session(B),
        subscription,
      }),
    ).rejects.toHaveProperty("code", "42501");
    await db.query(
      "update auth.sessions set not_after=now()-interval '1 second' where id=$1",
      [session(A)],
    );
    await expect(subscribe()).rejects.toHaveProperty("code", "42501");
    await db.query("update auth.sessions set not_after=null where id=$1", [
      session(A),
    ]);
    await db.query(
      "update auth.users set email_confirmed_at=null where id=$1",
      [A],
    );
    await expect(subscribe()).rejects.toHaveProperty("code", "42501");
    await db.query(
      "update auth.users set email_confirmed_at=now() where id=$1",
      [A],
    );
    for (let i = 1; i <= 8; i++)
      await subscribe(
        A,
        `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
    await expect(
      subscribe(A, "30000000-0000-4000-8000-000000000009"),
    ).rejects.toHaveProperty("code", "22023");
    await expect(subscribe()).resolves.toMatchObject({ registered: true });
  });
  it("never returns or disables another account's device", async () => {
    await subscribe();
    expect(await service("device", { userId: B, deviceId: DEVICE })).toBeNull();
    expect(await service("status", { userId: B, deviceId: DEVICE })).toBeNull();
    await service("disable", { userId: B, deviceId: DEVICE });
    expect(
      await service("device", { userId: A, deviceId: DEVICE }),
    ).toMatchObject({ userId: A, deviceId: DEVICE });
  });
  it("clears old account schedules and delivery claims when a device is reused by another account", async () => {
    await subscribe();
    await service("cache", {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      reminders: dueSchedule(),
      revision: "a".repeat(64),
    });
    expect(
      await service("claim", {
        userId: A,
        deviceId: DEVICE,
        snapshotRevision: 1,
        fingerprint: "same-reminder",
      }),
    ).toBe(true);
    await subscribe(B);
    expect(await service("device", { userId: A, deviceId: DEVICE })).toBeNull();
    const current = await service("device", { userId: B, deviceId: DEVICE });
    expect(current).toMatchObject({
      userId: B,
      schedule: [],
      cachedRevision: 0,
    });
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from private.reminder_deliveries where device_id=$1",
          [DEVICE],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("rejects stale schedule publication when a newer planner edit is committed", async () => {
    await subscribe();
    await seed(A, 2);
    expect(
      await service("cache", {
        userId: A,
        deviceId: DEVICE,
        snapshotRevision: 1,
        reminders: dueSchedule(),
      }),
    ).toEqual({ updated: false });
    expect(
      (await service("device", { userId: A, deviceId: DEVICE })) as object,
    ).toMatchObject({ snapshotRevision: 2, cachedRevision: 0, schedule: [] });
    expect(
      await service("cache", {
        userId: A,
        deviceId: DEVICE,
        snapshotRevision: 2,
        reminders: dueSchedule(),
      }),
    ).toEqual({ updated: true });
  });
  it("returns the authoritative payload for expired caches even without a new planner revision", async () => {
    await subscribe();
    await service("cache", {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      reminders: dueSchedule(Date.now() + 600_000),
    });
    expect(await service("devices", { deviceId: DEVICE })).toMatchObject([
      { cachedRevision: 1, snapshotRevision: 1, payload: null, refresh: false },
    ]);
    await db.exec(
      "update private.reminder_devices set refreshed_at=now()-interval '12 hours 1 minute'",
    );
    expect(await service("devices", { deviceId: DEVICE })).toMatchObject([
      {
        cachedRevision: 1,
        snapshotRevision: 1,
        payload: snapshot(),
        refresh: true,
      },
    ]);
  });
  it("claims a fingerprint once and rejects stale, disabled and opted-out schedules", async () => {
    await subscribe();
    const claim = {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      fingerprint: "synthetic-fingerprint",
    };
    expect(await service("claim", claim)).toBe(true);
    expect(await service("claim", claim)).toBe(false);
    await seed(A, 2);
    expect(await service("claim", { ...claim, fingerprint: "new-stale" })).toBe(
      false,
    );
    await seed(A, 2, false);
    expect(
      await service("claim", {
        ...claim,
        snapshotRevision: 2,
        fingerprint: "off",
      }),
    ).toBe(false);
    await seed(A, 2, true);
    await service("disable", { userId: A, deviceId: DEVICE });
    expect(
      await service("claim", {
        ...claim,
        snapshotRevision: 2,
        fingerprint: "disabled",
      }),
    ).toBe(false);
    expect(
      await service("status", { userId: A, deviceId: DEVICE }),
    ).toMatchObject({ registered: false, scheduled: 0, through: null });
  });
  it("stores delivery outcomes, prunes old claims and cancels all device rows after session revocation", async () => {
    await subscribe();
    const claim = {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      fingerprint: "synthetic-fingerprint",
    };
    await service("claim", claim);
    await service("outcome", {
      deviceId: DEVICE,
      fingerprint: claim.fingerprint,
      outcome: "accepted",
    });
    expect(
      (
        await db.query<{ outcome: string }>(
          "select outcome from private.reminder_deliveries where device_id=$1",
          [DEVICE],
        )
      ).rows[0].outcome,
    ).toBe("accepted");
    await db.exec(
      "update private.reminder_deliveries set claimed_at=now()-interval '31 days'",
    );
    await service("prune");
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from private.reminder_deliveries",
        )
      ).rows[0].n,
    ).toBe(0);
    await db.query("delete from auth.sessions where id=$1", [session(A)]);
    expect(await service("device", { userId: A, deviceId: DEVICE })).toBeNull();
    expect(await service("claim", { ...claim, fingerprint: "revoked" })).toBe(
      false,
    );
  });
  it("rechecks account/session status at claim time after a device was selected for delivery", async () => {
    await subscribe();
    expect(await service("devices", { deviceId: DEVICE })).toHaveLength(1);
    await db.query(
      "update auth.users set banned_until=now()+interval '1 day' where id=$1",
      [A],
    );
    expect(
      await service("claim", {
        userId: A,
        deviceId: DEVICE,
        snapshotRevision: 1,
        fingerprint: "banned-after-selection",
      }),
    ).toBe(false);
    await db.query("update auth.users set banned_until=null where id=$1", [A]);
    await db.query(
      "update auth.sessions set not_after=now()-interval '1 second' where id=$1",
      [session(A)],
    );
    expect(
      await service("claim", {
        userId: A,
        deviceId: DEVICE,
        snapshotRevision: 1,
        fingerprint: "expired-after-selection",
      }),
    ).toBe(false);
  });
  it("does not dispatch revoked, banned, unverified, anonymous, stale or opted-out users", async () => {
    await subscribe();
    expect(await service("devices", { deviceId: DEVICE })).toHaveLength(1);
    for (const update of [
      "email_confirmed_at=null",
      "is_anonymous=true",
      "deleted_at=now()",
      "banned_until=now()+interval '1 day'",
    ]) {
      await db.exec(`update auth.users set ${update} where id='${A}'`);
      expect(await service("devices", { deviceId: DEVICE })).toEqual([]);
      await db.exec(
        `update auth.users set email_confirmed_at=now(),is_anonymous=false,deleted_at=null,banned_until=null where id='${A}'`,
      );
    }
    await db.query(
      "update auth.sessions set not_after=now()-interval '1 second' where id=$1",
      [session(A)],
    );
    expect(await service("devices", { deviceId: DEVICE })).toEqual([]);
    await db.query("update auth.sessions set not_after=null where id=$1", [
      session(A),
    ]);
    await seed(A, 2, false);
    expect(await service("devices", { deviceId: DEVICE })).toEqual([]);
    await seed(A, 3, true);
    await db.exec(
      "update private.reminder_devices set last_seen=now()-interval '31 days'",
    );
    expect(await service("devices", { deviceId: DEVICE })).toEqual([]);
  });
  it("queues only eligible due or dirty devices and keeps cron credentials out of planner snapshots", async () => {
    await subscribe();
    await db.query("select private.dispatch_wakey_reminders()");
    const jobs = (
      await db.query<{
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      }>("select url,headers,body from net.requests")
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(
      "https://zhdoydzgtuskiflnzzxh.supabase.co/functions/v1/wakey-reminders",
    );
    expect(jobs[0].body).toMatchObject({ action: "dispatch" });
    expect(jobs[0].headers["x-wakey-cron"]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await db.query<{ payload: string }>(
          "select payload from public.planner_snapshots where user_id=$1",
          [A],
        )
      ).rows[0].payload,
    ).toBe(snapshot());
    const cron = (
      await db.query<{ command: string; schedule: string }>(
        "select command,schedule from cron.job where jobname='wakey-due-alerts'",
      )
    ).rows[0];
    expect(cron.schedule).toBe("* * * * *");
    expect(cron.command).toContain("private.dispatch_wakey_reminders()");
    expect(migration).not.toContain("synthetic-cron");
  });
  it("does not invoke the Edge dispatcher for a refreshed device whose alerts are not due", async () => {
    await subscribe();
    await service("cache", {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      reminders: dueSchedule(Date.now() + 600_000),
    });
    expect(
      (
        await db.query<{ result: number }>(
          "select private.dispatch_wakey_reminders() as result",
        )
      ).rows[0].result,
    ).toBe(0);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from net.requests",
        )
      ).rows[0].n,
    ).toBe(0);
    await service("cache", {
      userId: A,
      deviceId: DEVICE,
      snapshotRevision: 1,
      reminders: dueSchedule(Date.now() - 30_000),
    });
    expect(
      (
        await db.query<{ result: number }>(
          "select private.dispatch_wakey_reminders() as result",
        )
      ).rows[0].result,
    ).toBe(1);
  });
  it("fans out more than 50 eligible devices without dropping devices at an arbitrary global cap", async () => {
    // Fifteen synthetic owners with five devices each remain within the
    // independently tested eight-device registration limit. Seed in bulk so
    // this capacity check does not spend most of its time changing SQL roles.
    await db.exec(`insert into auth.users(id,email,email_confirmed_at,encrypted_password)
      select ('10000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
        'synthetic-'||g||'@example.invalid',now(),'synthetic-auth-provider-hash' from generate_series(10,24) g;
      insert into auth.sessions(id,user_id) select replace(id::text,'10000000-','20000000-')::uuid,id
        from auth.users where email like 'synthetic-%';`);
    await db.query(
      "insert into public.planner_snapshots(user_id,payload,revision) select id,$1,1 from auth.users where email like 'synthetic-%'",
      [snapshot()],
    );
    await db.query(
      `insert into private.reminder_devices(device_id,user_id,session_id,subscription,snapshot_revision,schedule,refreshed_at)
      select ('30000000-0000-4000-8000-'||lpad((row_number() over(order by a.id,g))::text,12,'0'))::uuid,
        a.id,replace(a.id::text,'10000000-','20000000-')::uuid,$1::jsonb,1,$2::jsonb,now()
      from auth.users a cross join generate_series(1,5) g where a.email like 'synthetic-%'`,
      [
        JSON.stringify(subscription),
        JSON.stringify(dueSchedule(Date.now() - 10_000)),
      ],
    );
    expect(
      (
        await db.query<{ result: number }>(
          "select private.dispatch_wakey_reminders() as result",
        )
      ).rows[0].result,
    ).toBe(75);
    const requests = (
      await db.query<{ body: { action: string; deviceId: string } }>(
        "select body from net.requests",
      )
    ).rows;
    expect(requests).toHaveLength(75);
    expect(new Set(requests.map((request) => request.body.deviceId)).size).toBe(
      75,
    );
    expect(
      requests.every((request) => request.body.action === "dispatch"),
    ).toBe(true);
  });
});
