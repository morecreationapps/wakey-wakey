import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { initialState } from "../src/data/defaults";

// Real PostgreSQL/pgcrypto/PLpgSQL and RLS run in PGlite. Auth table fixtures simulate
// provider-owned identity/session records, not email delivery or signed JWT issuance.
const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const ADMIN = "10000000-0000-4000-8000-000000000003";
const session = (id: string) => id.replace(/^1/, "2");
const ADMIN_EMAIL = "approved-admin@example.invalid";
let db: PGlite;
type ValidatorDefinition = {
  source: string;
  metadata: Record<string, unknown>;
};
let previousValidator: ValidatorDefinition;
let expandedValidator: ValidatorDefinition;
let writtenISOValidator: ValidatorDefinition;
let latestPreferenceMigration: string;
let previousExpandedChoiceError: string | undefined;
let previousWrittenISOChoiceError: string | undefined;
const snapshot = (name: string) => {
  const state = initialState();
  state.settings.name = name;
  state.settings.routines = [
    {
      id: "routine",
      name: "Prepare",
      minutes: 15,
      essential: true,
      includes: ["bag"],
    },
  ];
  state.templates = [
    {
      id: "template",
      name: "Early",
      duty: "E",
      category: "Early",
      start: "06:00",
      end: "14:18",
    },
  ];
  state.entries = [
    {
      id: "entry",
      date: "2026-10-10",
      duty: "L",
      category: "Late",
      status: "Work",
      start: "2026-10-10T14:08",
      end: "2026-10-10T22:26",
      timezone: "Europe/London",
      location: "Work",
      notes: "Exact fixture notes",
      overtimeMinutes: 0,
      breakMinutes: null,
      paidMinutes: null,
    },
  ];
  state.patterns = [
    {
      id: "pattern",
      name: "Pattern",
      startDate: "2026-10-13",
      until: "2026-10-21",
      days: [{ status: "Work", templateId: "template" }, { status: "Rest" }],
    },
  ];
  state.tasks = [
    {
      id: "task",
      title: "Prepare lunch",
      kind: "essential",
      minutes: 30,
      deadline: "2026-10-10T13:00",
      earliest: "2026-10-10T08:00",
      windowStart: "08:00",
      windowEnd: "13:00",
      priority: 1,
      recurrence: "none",
      location: "Home",
      travelMinutes: 0,
      movable: true,
      splittable: false,
      locked: false,
      scheduledStart: null,
      state: "pending",
      occurrenceStates: { "2026-10-10": "accepted" },
      linkedShiftId: "entry",
    },
  ];
  state.sleepLogs = [
    {
      id: "sleep",
      date: "2026-10-10",
      bedtime: "2026-10-09T22:00",
      wake: "2026-10-10T06:00",
      estimatedMinutes: 480,
      awakenings: 1,
      rested: "Fair",
    },
  ];
  return JSON.stringify(state);
};
const payload = snapshot("Original verified fixture");
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

async function owner() {
  await db.exec("reset role");
}
async function validatorDefinition() {
  return (
    await db.query<ValidatorDefinition>(`
      select p.prosrc as source,
        to_jsonb(p) - 'prosrc' - 'prosqlbody' as metadata
      from pg_catalog.pg_proc p
      where p.oid = 'private.validate_snapshot(text)'::regprocedure
    `)
  ).rows[0];
}
async function user(
  id: string,
  methods = ["password"],
  extra: Record<string, unknown> = {},
) {
  await owner();
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({
      sub: id,
      role: "authenticated",
      session_id: session(id),
      amr: methods.map((method) => ({
        method,
        timestamp: Math.floor(Date.now() / 1000),
      })),
      ...extra,
    }),
  ]);
  await db.exec("set role authenticated");
}
async function rpc(name: string, parameters: unknown[] = []) {
  const placeholders = parameters.map((_, index) => `$${index + 1}`).join(",");
  return (
    await db.query<{ result: Record<string, unknown> }>(
      `select public.${name}(${placeholders}) as result`,
      parameters,
    )
  ).rows[0].result;
}
async function reserveAndBind(id = ADMIN, email = ADMIN_EMAIL, text = payload) {
  await owner();
  await db.query("select private.reserve_admin_migration($1,$2)", [
    email,
    digest(text),
  ]);
  await db.query("select private.prepare_admin_migration($1::uuid,$2,$3)", [
    id,
    email,
    digest(text),
  ]);
  await user(id);
}

describe("executed PostgreSQL account security", () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (
        id uuid primary key, email text, email_confirmed_at timestamptz,
        encrypted_password text, is_anonymous boolean default false,
        deleted_at timestamptz, banned_until timestamptz
      );
      create table auth.sessions (id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb);
      $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
      grant usage on schema auth to authenticated,anon;
    `);
    const directory = new URL("../supabase/migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), "utf8");
      if (file === "20261008132658_written_iso_date_format.sql") {
        const expanded = JSON.parse(payload);
        expanded.settings.dateFormat = "LONG_ISO";
        try {
          await db.query("select private.validate_snapshot($1)", [
            JSON.stringify(expanded),
          ]);
        } catch (error) {
          previousWrittenISOChoiceError = (error as { code?: string }).code;
        }
      }
      await db.exec(sql);
      if (file === "20261007190548_account_security.sql") {
        previousValidator = await validatorDefinition();
        const expanded = JSON.parse(payload);
        expanded.settings.dateFormat = "LONG";
        expanded.settings.firstDay = "Saturday";
        try {
          await db.query("select private.validate_snapshot($1)", [
            JSON.stringify(expanded),
          ]);
        } catch (error) {
          previousExpandedChoiceError = (error as { code?: string }).code;
        }
      }
      if (file === "20261008110643_date_week_preferences.sql") {
        expandedValidator = await validatorDefinition();
      }
      if (file === "20261008132658_written_iso_date_format.sql") {
        latestPreferenceMigration = sql;
        writtenISOValidator = await validatorDefinition();
      }
    }
    for (const [id, email] of [
      [A, "alice@example.invalid"],
      [B, "bob@example.invalid"],
      [ADMIN, ADMIN_EMAIL],
    ]) {
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1::uuid,$2,now(),'provider-owned-test-hash')",
        [id, email],
      );
    }
  }, 30000);
  beforeEach(async () => {
    await owner();
    await db.exec(`delete from public.planner_snapshots; delete from private.account_roles;
      delete from private.admin_migration_grants; delete from private.migration_reservations;
      delete from private.planner_write_limits; delete from auth.sessions;
      update auth.users set email_confirmed_at=now(),is_anonymous=false,deleted_at=null,banned_until=null;`);
    for (const id of [A, B, ADMIN])
      await db.query(
        "insert into auth.sessions(id,user_id) values($1::uuid,$2::uuid)",
        [session(id), id],
      );
    await user(A);
  });
  afterAll(async () => {
    await db?.close();
  });

  it("creates and restores only the authenticated user's exact payload", async () => {
    expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
    expect(await rpc("planner_save", [payload, 0])).toEqual({
      payload,
      revision: 1,
    });
    expect(await rpc("planner_load")).toEqual({ payload, revision: 1 });
  });
  it("extends only the two preference lists and preserves validator ownership, ACL and attributes", () => {
    expect(previousExpandedChoiceError).toBe("22023");
    expect(expandedValidator.metadata).toEqual(previousValidator.metadata);
    expect(expandedValidator.source).toBe(
      previousValidator.source
        .replace(
          "perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO']);",
          "perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG']);",
        )
        .replace(
          "perform private.check_choice(settings->'firstDay','settings.firstDay',array['Monday','Sunday']);",
          "perform private.check_choice(settings->'firstDay','settings.firstDay',array['Monday','Sunday','Saturday']);",
        ),
    );
  });
  it("adds only written ISO dates and preserves the complete validator metadata", () => {
    expect(previousWrittenISOChoiceError).toBe("22023");
    expect(writtenISOValidator.metadata).toEqual(expandedValidator.metadata);
    expect(writtenISOValidator.source).toBe(
      expandedValidator.source.replace(
        "perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG']);",
        "perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG','LONG_ISO']);",
      ),
    );
  });
  it.each(
    ["UK", "ISO", "LONG", "LONG_ISO"].flatMap((format) =>
      ["Monday", "Sunday", "Saturday"].map((firstDay) => [format, firstDay]),
    ),
  )(
    "saves and restores %s dates with a %s week start",
    async (format, firstDay) => {
      const state = JSON.parse(payload);
      state.settings.dateFormat = format;
      state.settings.firstDay = firstDay;
      const exact = JSON.stringify(state);
      expect(await rpc("planner_save", [exact, 0])).toEqual({
        payload: exact,
        revision: 1,
      });
      expect(await rpc("planner_load")).toEqual({
        payload: exact,
        revision: 1,
      });
    },
  );
  it.each([
    ["dateFormat", "US"],
    ["dateFormat", "long"],
    ["dateFormat", "long_iso"],
    ["dateFormat", "LONG-ISO"],
    ["dateFormat", ""],
    ["firstDay", "Tuesday"],
    ["firstDay", "saturday"],
    ["firstDay", 7],
  ])(
    "rejects unsupported %s=%s without creating account data",
    async (field, value) => {
      const state = JSON.parse(payload);
      state.settings[field] = value;
      await expect(
        rpc("planner_save", [JSON.stringify(state), 0]),
      ).rejects.toThrow(/invalid choice/);
      expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
    },
  );
  it("reapplying the latest preference migration leaves the complete validator unchanged", async () => {
    await owner();
    await db.exec(latestPreferenceMigration);
    expect(await validatorDefinition()).toEqual(writtenISOValidator);
  });
  it("refuses to replace an unexpectedly changed validator", async () => {
    await owner();
    await db.exec("begin");
    try {
      const definition = (
        await db.query<{ definition: string }>(
          "select pg_get_functiondef('private.validate_snapshot(text)'::regprocedure) as definition",
        )
      ).rows[0].definition;
      await db.exec(
        definition.replace(
          "\nbegin\n",
          "\nbegin\n  -- Unexpected operator edit.\n",
        ),
      );
      await expect(db.exec(latestPreferenceMigration)).rejects.toThrow(
        /Unexpected snapshot validator source/,
      );
    } finally {
      await db.exec("rollback");
    }
    expect(await validatorDefinition()).toEqual(writtenISOValidator);
  });
  it("isolates two accounts in RPCs and direct owner RLS reads", async () => {
    await rpc("planner_save", [snapshot("Alice"), 0]);
    await user(B);
    expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
    expect(
      (await db.query("select * from public.planner_snapshots")).rows,
    ).toHaveLength(0);
    await rpc("planner_save", [snapshot("Bob"), 0]);
    expect(
      (
        await db.query<{ user_id: string }>(
          "select user_id from public.planner_snapshots",
        )
      ).rows,
    ).toEqual([{ user_id: B }]);
    await user(A);
    expect((await rpc("planner_load")).payload).toBe(snapshot("Alice"));
  });
  it("does not accept a caller-supplied account ID", async () => {
    await expect(
      db.query("select public.planner_load($1::uuid)", [B]),
    ).rejects.toThrow(/does not exist/);
    await expect(
      db.query("select public.planner_save($1,$2,$3::uuid)", [payload, 0, B]),
    ).rejects.toThrow(/does not exist/);
  });
  it("denies anonymous REST roles and direct inserts/updates/deletes", async () => {
    await db.exec("reset role; set role anon");
    await expect(rpc("planner_load")).rejects.toThrow(/permission denied/);
    await expect(
      db.query("select * from public.planner_snapshots"),
    ).rejects.toThrow(/permission denied/);
    await user(A);
    for (const sql of [
      "delete from public.planner_snapshots",
      "update public.planner_snapshots set revision=99",
      "insert into public.planner_snapshots(user_id,payload,revision) values('" +
        B +
        "','{}',1)",
    ]) {
      await expect(db.exec(sql)).rejects.toThrow(/permission denied/);
    }
  });
  it.each(["otp", "recovery", "magiclink", "oauth", "invite", "sso/saml"])(
    "denies %s sessions",
    async (method) => {
      await user(A, [method]);
      await expect(rpc("planner_load")).rejects.toThrow(
        /verified email-and-password session/,
      );
      await expect(rpc("planner_save", [payload, 0])).rejects.toThrow(
        /verified email-and-password session/,
      );
      expect(
        (await db.query("select * from public.planner_snapshots")).rows,
      ).toHaveLength(0);
    },
  );
  it("denies a recovery session even if it also contains password AMR", async () => {
    await user(A, ["password", "recovery"]);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
  });
  it("denies unverified and anonymous identities independently of their JWT role", async () => {
    await owner();
    await db.query(
      "update auth.users set email_confirmed_at=null where id=$1::uuid",
      [A],
    );
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
    await owner();
    await db.query(
      "update auth.users set email_confirmed_at=now(),is_anonymous=true where id=$1::uuid",
      [A],
    );
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
  });
  it("denies revoked, expired-server-session, banned and deleted identities", async () => {
    await owner();
    await db.query("delete from auth.sessions where user_id=$1::uuid", [A]);
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
    await owner();
    await db.query(
      "insert into auth.sessions(id,user_id,not_after) values($1::uuid,$2::uuid,now()-interval '1 minute')",
      [session(A), A],
    );
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
    await owner();
    await db.exec("update auth.sessions set not_after=null");
    await db.query(
      "update auth.users set banned_until=now()+interval '1 day' where id=$1::uuid",
      [A],
    );
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
    await owner();
    await db.query(
      "update auth.users set banned_until=null,deleted_at=now() where id=$1::uuid",
      [A],
    );
    await user(A);
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
  });
  it("does not let OAuth clients reuse password-authenticated tokens", async () => {
    await user(A, ["password"], { client_id: "external-client" });
    await expect(rpc("planner_load")).rejects.toThrow(
      /verified email-and-password session/,
    );
  });
  it("rejects stale writes without replacing newer records", async () => {
    await rpc("planner_save", [payload, 0]);
    await rpc("planner_save", [snapshot("Newer"), 1]);
    await expect(rpc("planner_save", [snapshot("Stale"), 1])).rejects.toThrow(
      /changed elsewhere/,
    );
    expect(await rpc("planner_load")).toEqual({
      payload: snapshot("Newer"),
      revision: 2,
    });
  });
  it("rejects malformed fields, missing records, duplicate IDs and unknown schema", async () => {
    const invalid = [
      "not JSON",
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({ ...initialState(), schemaVersion: 2 }),
      JSON.stringify({
        ...initialState(),
        settings: { ...initialState().settings, remindersEnabled: "true" },
      }),
      JSON.stringify({
        ...initialState(),
        settings: { ...initialState().settings, outboundMin: -1 },
      }),
      JSON.stringify({
        ...initialState(),
        settings: { ...initialState().settings, timezone: "made-up-zone" },
      }),
      JSON.stringify({
        ...initialState(),
        templates: [{ id: "same" }, { id: "same" }],
      }),
      JSON.stringify({ ...initialState(), tasks: [{ id: "task" }] }),
    ];
    for (const bad of invalid)
      await expect(rpc("planner_save", [bad, 0])).rejects.toThrow(/Invalid/);
    expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
  });
  it("enforces the server save limit", async () => {
    await owner();
    await db.query(
      "insert into private.planner_write_limits values($1::uuid,date_trunc('minute',clock_timestamp()),120)",
      [A],
    );
    await user(A);
    await expect(rpc("planner_save", [payload, 0])).rejects.toThrow(
      /Too many saves/,
    );
    expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
  });
  it("ignores forged user metadata and keeps all trusted setup methods private", async () => {
    await user(A, ["password"], {
      user_metadata: { admin: true, email: ADMIN_EMAIL },
    });
    expect(await rpc("planner_migration_status")).toEqual({
      eligible: false,
      completed: false,
    });
    for (const sql of [
      "select * from private.admin_migration_grants",
      "select * from private.migration_reservations",
      "select * from private.account_roles",
      "select private.reserve_admin_migration('approved-admin@example.invalid','" +
        digest(payload) +
        "')",
      "select private.prepare_admin_migration('" +
        A +
        "','alice@example.invalid','" +
        digest(payload) +
        "')",
    ]) {
      await expect(db.exec(sql)).rejects.toThrow(/permission denied/);
    }
  });
  it("reserves the administrator before signup without granting a role or allowing defaults", async () => {
    await owner();
    await db.query("select private.reserve_admin_migration($1,$2)", [
      ADMIN_EMAIL,
      digest(payload),
    ]);
    expect(
      (await db.query("select * from private.account_roles")).rows,
    ).toHaveLength(0);
    await user(ADMIN);
    for (const name of ["planner_load", "planner_migration_status"])
      await expect(rpc(name)).rejects.toThrow(
        /awaiting trusted migration approval/,
      );
    await expect(
      rpc("planner_save", [snapshot("Defaults"), 0]),
    ).rejects.toThrow(/awaiting trusted migration approval/);
    await owner();
    expect(
      (await db.query("select * from public.planner_snapshots")).rows,
    ).toHaveLength(0);
  });
  it("requires a verified account, approved server email and pre-existing matching reservation", async () => {
    await owner();
    await expect(
      db.query("select private.prepare_admin_migration($1::uuid,$2,$3)", [
        ADMIN,
        ADMIN_EMAIL,
        digest(payload),
      ]),
    ).rejects.toThrow(/matching trusted reservation/);
    await db.query("select private.reserve_admin_migration($1,$2)", [
      ADMIN_EMAIL,
      digest(payload),
    ]);
    await expect(
      db.query("select private.prepare_admin_migration($1::uuid,$2,$3)", [
        A,
        ADMIN_EMAIL,
        digest(payload),
      ]),
    ).rejects.toThrow(/approved account/);
    await db.query(
      "update auth.users set email_confirmed_at=null where id=$1::uuid",
      [ADMIN],
    );
    await expect(
      db.query("select private.prepare_admin_migration($1::uuid,$2,$3)", [
        ADMIN,
        ADMIN_EMAIL,
        digest(payload),
      ]),
    ).rejects.toThrow(/approved account/);
    await expect(
      db.query("select private.prepare_admin_migration($1::uuid,null,$2)", [
        A,
        digest(payload),
      ]),
    ).rejects.toThrow(/approved account/);
  });
  it("migrates byte-identical records once and atomically verifies the receipt", async () => {
    await reserveAndBind();
    expect(await rpc("planner_migration_status")).toEqual({
      eligible: true,
      completed: false,
      digest: digest(payload),
    });
    await expect(
      rpc("planner_save", [snapshot("Defaults"), 0]),
    ).rejects.toThrow(/must be migrated/);
    expect(
      await rpc("planner_migrate_legacy", [payload, digest(payload)]),
    ).toEqual({ payload, revision: 1, digest: digest(payload) });
    expect(await rpc("planner_migration_status")).toEqual({
      eligible: true,
      completed: true,
      digest: digest(payload),
    });
    expect(await rpc("planner_load")).toEqual({ payload, revision: 1 });
    await owner();
    const rows = (
      await db.query<{ role: string }>(
        "select role from private.account_roles where user_id=$1::uuid",
        [ADMIN],
      )
    ).rows;
    expect(rows).toEqual([{ role: "admin" }]);
  });
  it("reruns migration without duplicating or overwriting newer settings", async () => {
    await reserveAndBind();
    await rpc("planner_migrate_legacy", [payload, digest(payload)]);
    await rpc("planner_save", [snapshot("Newer settings"), 1]);
    expect(
      await rpc("planner_migrate_legacy", [payload, digest(payload)]),
    ).toEqual({
      payload: snapshot("Newer settings"),
      revision: 2,
      digest: digest(payload),
    });
    await owner();
    expect(
      (await db.query("select * from public.planner_snapshots")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from private.admin_migration_grants")).rows,
    ).toHaveLength(1);
  });
  it("rejects changed backup bytes or a different digest without completing migration", async () => {
    await reserveAndBind();
    await expect(
      rpc("planner_migrate_legacy", [snapshot("Changed"), digest(payload)]),
    ).rejects.toThrow(/does not match/);
    await expect(
      rpc("planner_migrate_legacy", [payload, digest(snapshot("Changed"))]),
    ).rejects.toThrow(/no matching legacy migration grant/);
    expect(await rpc("planner_migration_status")).toEqual({
      eligible: true,
      completed: false,
      digest: digest(payload),
    });
    expect(await rpc("planner_load")).toEqual({ payload: null, revision: 0 });
  });
  it("refuses existing records and never grants admin access to another user's data", async () => {
    await user(ADMIN);
    await rpc("planner_save", [snapshot("Existing"), 0]);
    await owner();
    await expect(
      db.query("select private.reserve_admin_migration($1,$2)", [
        ADMIN_EMAIL,
        digest(payload),
      ]),
    ).rejects.toThrow(/will not|already has saved/);
    await db.exec("delete from public.planner_snapshots");
    await reserveAndBind();
    await rpc("planner_migrate_legacy", [payload, digest(payload)]);
    await user(B);
    await rpc("planner_save", [snapshot("Private Bob"), 0]);
    await user(ADMIN);
    expect(
      (
        await db.query<{ user_id: string }>(
          "select user_id from public.planner_snapshots",
        )
      ).rows,
    ).toEqual([{ user_id: ADMIN }]);
    await user(B);
    await expect(
      rpc("planner_migrate_legacy", [payload, digest(payload)]),
    ).rejects.toThrow(/no matching legacy migration grant/);
  });
});
