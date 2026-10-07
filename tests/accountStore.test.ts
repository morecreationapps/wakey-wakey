import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../src/data/defaults";
import { AppState } from "../src/model";
import {
  ACCOUNT_CACHE_PREFIX,
  AccountRemote,
  AccountStoreError,
  createAccountStore,
  accountAccessError,
  handleAccountAccessDenied,
} from "../src/auth/accountStore";
import type { AccountCache } from "../src/platform/accountCache";
import {
  activateNotificationOwner,
  clearNotificationOwner,
  notificationScope,
  notificationScopeCurrent,
} from "../src/platform/notificationScope";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const hash = async (payload: string) =>
  createHash("sha256").update(payload).digest("hex");
function cacheFixture() {
  const values = new Map<string, string>();
  const cache: AccountCache = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { values, cache };
}
function remoteFixture(payload: string | null = null) {
  let saved = payload;
  let revision = payload === null ? 0 : 1;
  let completed = false;
  let digest: string | undefined;
  const calls: string[] = [];
  const remote: AccountRemote = {
    migrationStatus: vi.fn(async () => {
      calls.push("status");
      return { eligible: false, completed, digest };
    }),
    load: vi.fn(async () => {
      calls.push("load");
      return { payload: saved, revision };
    }),
    save: vi.fn(async (next, expected) => {
      calls.push("save");
      if (expected !== revision)
        throw new AccountStoreError(
          "CONFLICT",
          "A newer account revision exists.",
        );
      saved = next;
      return { payload: next, revision: ++revision };
    }),
    migrate: vi.fn(async (next, nextDigest) => {
      calls.push("migrate");
      if (saved !== null || completed)
        throw new AccountStoreError(
          "CONFLICT",
          "Migration cannot overwrite account records.",
        );
      saved = next;
      digest = nextDigest;
      completed = true;
      revision = 1;
      return { payload: next, revision, digest: nextDigest };
    }),
  };
  return {
    remote,
    calls,
    payload: () => saved,
    revision: () => revision,
    eligible() {
      vi.mocked(remote.migrationStatus).mockImplementation(async () => {
        calls.push("status");
        return { eligible: true, completed, digest };
      });
    },
  };
}
function preservedState(): AppState {
  const a = initialState();
  a.settings = {
    ...a.settings,
    name: "Original settings",
    role: "Recorded role",
    onboardingComplete: true,
    onboardingStep: 6,
    outboundMin: 17,
    outboundMax: 26,
    returnMinutes: 19,
    arrivalBuffer: 12,
    sleepTarget: 435,
    latency: 21,
    windDown: 47,
    earlyBed: "21:18",
    earlyWake: "05:17",
    lateBed: "00:29",
    lateWake: "08:42",
    restBed: "23:46",
    restWake: "08:16",
    timezoneConfirmed: true,
    reminderKinds: ["prepare", "appointment"],
    remindersEnabled: true,
    routines: [
      {
        id: "routine",
        name: "Recorded preparation",
        minutes: 29,
        includes: ["breakfast"],
        essential: true,
      },
    ],
  };
  a.templates = [
    {
      id: "own-template",
      name: "My template",
      duty: "TEST",
      category: "Custom",
      start: "09:17",
      end: "17:41",
    },
  ];
  a.patterns = [
    {
      id: "pattern",
      name: "Own pattern",
      startDate: "2032-10-10",
      until: "2032-10-20",
      days: [
        { templateId: "own-template", status: "Work" },
        { status: "Rest" },
      ],
    },
  ];
  a.entries = [
    {
      id: "entry",
      date: "2032-10-10",
      duty: "TEST",
      category: "Custom",
      status: "Work",
      start: "2032-10-10T09:17",
      end: "2032-10-10T17:41",
      timezone: "Europe/London",
      overtimeMinutes: 11,
      location: "Recorded workplace",
      notes: "Private note",
      breakMinutes: 38,
      paidMinutes: 466,
      patternId: "pattern",
      exception: true,
    },
  ];
  a.tasks = [
    {
      id: "task",
      title: "Own task",
      kind: "essential",
      minutes: 23,
      earliest: "2032-10-09T12:00",
      deadline: "2032-10-10T08:00",
      windowStart: "12:00",
      windowEnd: "19:00",
      priority: 4,
      recurrence: "daily",
      location: "Home",
      travelMinutes: 0,
      movable: true,
      splittable: false,
      locked: false,
      scheduledStart: "2032-10-09T13:20",
      state: "accepted",
      occurrenceStates: { "2032-10-09": "completed" },
      linkedShiftId: "entry",
    },
  ];
  a.sleepLogs = [
    {
      id: "sleep",
      date: "2032-10-09",
      bedtime: "2032-10-08T23:18",
      wake: "2032-10-09T07:11",
      estimatedMinutes: 441,
      awakenings: 2,
      rested: "Recorded diary",
    },
  ];
  return a;
}
function create(
  userId: string,
  remote: AccountRemote,
  cache: AccountCache,
  legacy: string | null = null,
) {
  const readLegacy = vi.fn(async () => legacy);
  const store = createAccountStore({ userId, remote, cache, readLegacy, hash });
  return { store, readLegacy };
}

describe("trusted setup-pending access classification", () => {
  const message = "Administrator setup is awaiting trusted migration approval.";

  it("retains authentication only for the exact backend setup gate", () => {
    const error = accountAccessError(403, { code: "42501", message });
    expect(error).toMatchObject({ code: "SETUP_PENDING", message });
    const deactivate = vi.fn(),
      logout = vi.fn(async () => undefined);
    expect(handleAccountAccessDenied(error, { deactivate, logout })).toBe(
      false,
    );
    expect(deactivate).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(accountAccessError(200, {})).toBeNull();
    expect(accountAccessError(403, null)).toMatchObject({
      code: "PERMISSION_ERROR",
    });
  });

  it.each([
    { status: 401, code: "42501", message, expected: "AUTH_ERROR" },
    {
      status: 403,
      code: "42501",
      message: `${message} `,
      expected: "PERMISSION_ERROR",
    },
    {
      status: 403,
      code: "42501",
      message: "Not authorised",
      expected: "PERMISSION_ERROR",
    },
    { status: 403, code: "other", message, expected: "PERMISSION_ERROR" },
    { status: 403, code: undefined, message, expected: "PERMISSION_ERROR" },
    { status: 500, code: "42501", message, expected: "PERMISSION_ERROR" },
  ])(
    "still logs out for a non-matching denial ($status, $code, $expected)",
    async ({ status, code, message: denialMessage, expected }) => {
      const error = accountAccessError(status, {
        code,
        message: denialMessage,
      });
      expect(error).toMatchObject({ code: expected });
      const deactivate = vi.fn(),
        logout = vi.fn(async () => undefined);
      expect(handleAccountAccessDenied(error, { deactivate, logout })).toBe(
        true,
      );
      expect(deactivate).toHaveBeenCalledOnce();
      expect(logout).toHaveBeenCalledOnce();
    },
  );
});

describe("owner-scoped account snapshots", () => {
  it.each(["empty", "cached"] as const)(
    "returns no cached, default or legacy planner while trusted setup is pending (%s device)",
    async (device) => {
      const c = cacheFixture(),
        original = JSON.stringify(preservedState());
      c.values.set("wakey-wakey:snapshot:v1", original);
      const r = remoteFixture(device === "cached" ? original : null);
      if (device === "cached")
        await create(ADMIN, r.remote, c.cache).store.loadState();
      vi.mocked(r.remote.load).mockClear();
      const before = new Map(c.values);
      const denial = accountAccessError(403, {
        code: "42501",
        message: "Administrator setup is awaiting trusted migration approval.",
      });
      vi.mocked(r.remote.migrationStatus).mockRejectedValueOnce(denial);
      const { store, readLegacy } = create(ADMIN, r.remote, c.cache, original);

      await expect(store.loadState()).rejects.toMatchObject({
        code: "SETUP_PENDING",
      });

      expect(store.status()).toMatchObject({ loaded: false, offline: false });
      expect(readLegacy).not.toHaveBeenCalled();
      expect(r.remote.load).not.toHaveBeenCalled();
      expect(r.remote.migrate).not.toHaveBeenCalled();
      expect(r.remote.save).not.toHaveBeenCalled();
      expect(c.values).toEqual(before);
      await expect(store.saveState(initialState())).rejects.toMatchObject({
        code: "NOT_LOADED",
      });
      expect(r.remote.save).not.toHaveBeenCalled();
      expect(c.values).toEqual(before);
    },
  );

  it.each(["missing", "older"] as const)(
    "retains a clean nonzero-revision cache when server records are %s",
    async (result) => {
      const c = cacheFixture(),
        r = remoteFixture(JSON.stringify(preservedState()));
      const store = create(OTHER, r.remote, c.cache).store;
      await store.loadState();
      const latest = preservedState();
      latest.settings.name = "Latest saved settings";
      await store.saveState(latest);
      const originalCache = c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`);
      vi.mocked(r.remote.load).mockResolvedValue(
        result === "missing"
          ? { payload: null, revision: 0 }
          : { payload: JSON.stringify(preservedState()), revision: 1 },
      );
      const restarted = create(OTHER, r.remote, c.cache).store;
      await expect(restarted.loadState()).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(restarted.status().loaded).toBe(false);
      expect(c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)).toBe(
        originalCache,
      );
      expect(r.remote.save).toHaveBeenCalledOnce();
      await expect(restarted.saveState(initialState())).rejects.toMatchObject({
        code: "NOT_LOADED",
      });
    },
  );

  it.each(["missing", "older-matching", "older-different"] as const)(
    "retains dirty local edits and their revision when server records are %s",
    async (result) => {
      const c = cacheFixture(),
        r = remoteFixture(JSON.stringify(preservedState()));
      const store = create(OTHER, r.remote, c.cache).store;
      await store.loadState();
      const baseline = preservedState();
      baseline.settings.name = "Second saved revision";
      await store.saveState(baseline);
      const pending = preservedState();
      pending.settings.name = "Own pending offline change";
      vi.mocked(r.remote.save).mockRejectedValueOnce(
        new AccountStoreError("NETWORK_ERROR", "Offline"),
      );
      await store.saveState(pending);
      const originalCache = c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`);
      vi.mocked(r.remote.load).mockResolvedValue(
        result === "missing"
          ? { payload: null, revision: 0 }
          : {
              payload: JSON.stringify(
                result === "older-matching" ? pending : baseline,
              ),
              revision: 1,
            },
      );
      await expect(
        create(OTHER, r.remote, c.cache).store.loadState(),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)).toBe(
        originalCache,
      );
      expect(JSON.parse(originalCache!)).toMatchObject({
        dirty: true,
        revision: 2,
        payload: JSON.stringify(pending),
      });
      expect(r.remote.save).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed for an approved pending migration when the original legacy planner is unavailable", async () => {
    const c = cacheFixture(),
      r = remoteFixture();
    r.eligible();
    const original = JSON.stringify(preservedState());
    c.values.set("wakey-wakey:snapshot:v1", original);
    const { store, readLegacy } = create(ADMIN, r.remote, c.cache, null);
    await expect(store.loadState()).rejects.toMatchObject({
      code: "MIGRATION_REQUIRED",
    });
    expect(readLegacy).toHaveBeenCalledOnce();
    expect(store.status().loaded).toBe(false);
    await expect(store.saveState(initialState())).rejects.toMatchObject({
      code: "NOT_LOADED",
    });
    expect(r.remote.migrate).not.toHaveBeenCalled();
    expect(r.remote.save).not.toHaveBeenCalled();
    expect(c.values.get("wakey-wakey:snapshot:v1")).toBe(original);
    expect(c.values.has(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)).toBe(false);
  });

  it.each(["AUTH_ERROR", "PERMISSION_ERROR"] as const)(
    "deactivates the current account on %s without deleting its preserved snapshots",
    async (code) => {
      const c = cacheFixture(),
        r = remoteFixture(),
        original = JSON.stringify(preservedState());
      r.eligible();
      const store = create(ADMIN, r.remote, c.cache, original).store;
      await store.loadState();
      const migratedCache = c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`);
      const backup = c.values.get(
        `${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`,
      );
      activateNotificationOwner(ADMIN);
      const scope = notificationScope();
      let identity: string | null = ADMIN;
      const deactivate = vi.fn(() => clearNotificationOwner(ADMIN));
      const logout = vi.fn(async () => {
        identity = null;
        throw new Error("Revocation service unreachable");
      });
      vi.mocked(r.remote.save).mockRejectedValueOnce(
        new AccountStoreError(code, "Access denied"),
      );
      const edited = preservedState();
      edited.settings.name = "Pending own change";
      let denial: unknown;
      try {
        await store.saveState(edited);
      } catch (error) {
        denial = error;
      }
      expect(handleAccountAccessDenied(denial, { deactivate, logout })).toBe(
        true,
      );
      expect(deactivate).toHaveBeenCalledOnce();
      expect(logout).toHaveBeenCalledOnce();
      expect(identity).toBeNull();
      expect(notificationScopeCurrent(scope)).toBe(false);
      expect(
        c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`),
      ).toBe(backup);
      expect(c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)).not.toBe(
        migratedCache,
      );
      expect(
        JSON.parse(c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)!).payload,
      ).toBe(JSON.stringify(edited));
      expect(r.payload()).toBe(original);
    },
  );

  it.each([
    "NETWORK_ERROR",
    "CONFLICT",
    "CORRUPT_DATA",
    "MIGRATION_REQUIRED",
  ] as const)("does not turn %s into an account logout", (code) => {
    const deactivate = vi.fn(),
      logout = vi.fn(async () => undefined);
    expect(
      handleAccountAccessDenied(
        new AccountStoreError(code, "Recoverable account issue"),
        { deactivate, logout },
      ),
    ).toBe(false);
    expect(deactivate).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it("initialises only after confirmed server absence and checks the backend migration grant first", async () => {
    const c = cacheFixture(),
      r = remoteFixture(),
      { store, readLegacy } = create(
        OTHER,
        r.remote,
        c.cache,
        JSON.stringify(preservedState()),
      );
    expect(await store.loadState()).toEqual(initialState());
    expect(r.calls).toEqual(["status", "load"]);
    expect(readLegacy).not.toHaveBeenCalled();
    expect(store.status()).toMatchObject({
      loaded: true,
      offline: false,
      revision: 0,
      migration: "none",
    });
  });

  it("keeps two account caches isolated and refuses a cache with another owner", async () => {
    const c = cacheFixture(),
      a = remoteFixture(JSON.stringify(preservedState())),
      b = remoteFixture();
    const admin = create(ADMIN, a.remote, c.cache).store,
      other = create(OTHER, b.remote, c.cache).store;
    await admin.loadState();
    await other.loadState();
    const fresh = initialState();
    fresh.settings.name = "Second user";
    await other.saveState(fresh);
    expect(await admin.loadState()).toEqual(preservedState());
    expect(
      JSON.parse(c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)!).payload,
    ).toBe(JSON.stringify(fresh));
    c.values.set(
      `${ACCOUNT_CACHE_PREFIX}${OTHER}`,
      c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)!,
    );
    await expect(
      create(OTHER, b.remote, c.cache).store.loadState(),
    ).rejects.toMatchObject({ code: "CORRUPT_DATA" });
  });

  it("migrates the exact raw legacy snapshot only for a trusted eligible UID, preserving every record and backup", async () => {
    const state = preservedState(),
      original = JSON.stringify(state, null, 2);
    const c = cacheFixture(),
      r = remoteFixture();
    r.eligible();
    const { store, readLegacy } = create(ADMIN, r.remote, c.cache, original);
    expect(await store.loadState()).toEqual(state);
    expect(r.remote.migrate).toHaveBeenCalledExactlyOnceWith(
      original,
      await hash(original),
    );
    expect(readLegacy).toHaveBeenCalledOnce();
    expect(r.payload()).toBe(original);
    const backup = JSON.parse(
      c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`)!,
    );
    expect(backup).toMatchObject({
      payload: original,
      digest: await hash(original),
      ownerId: ADMIN,
    });
    expect(store.status().migration).toBe("verified");
  });

  it("reruns migration without duplicating or overwriting newer account settings", async () => {
    const original = JSON.stringify(preservedState());
    const c = cacheFixture(),
      r = remoteFixture();
    r.eligible();
    const first = create(ADMIN, r.remote, c.cache, original);
    const migrated = await first.store.loadState();
    migrated.settings.outboundMin = 21;
    await first.store.saveState(migrated);
    const second = create(ADMIN, r.remote, c.cache, original);
    expect((await second.store.loadState()).settings.outboundMin).toBe(21);
    expect(second.readLegacy).not.toHaveBeenCalled();
    expect(r.remote.migrate).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`)!,
      ).payload,
    ).toBe(original);
  });

  it("stops a migration when the destination already has records", async () => {
    const original = JSON.stringify(preservedState()),
      newer = initialState();
    newer.settings.name = "Existing newer account";
    const c = cacheFixture(),
      r = remoteFixture(JSON.stringify(newer));
    r.eligible();
    await expect(
      create(ADMIN, r.remote, c.cache, original).store.loadState(),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(r.remote.migrate).not.toHaveBeenCalled();
    expect(r.payload()).toBe(JSON.stringify(newer));
    expect(c.values.has(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)).toBe(false);
  });

  it("retains the backup and refuses a migration response whose digest or records do not match", async () => {
    const original = JSON.stringify(preservedState()),
      c = cacheFixture(),
      r = remoteFixture();
    r.eligible();
    vi.mocked(r.remote.migrate).mockResolvedValue({
      payload: JSON.stringify(initialState()),
      revision: 1,
      digest: await hash(original),
    });
    const { store } = create(ADMIN, r.remote, c.cache, original);
    await expect(store.loadState()).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect(c.values.has(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)).toBe(false);
    expect(
      JSON.parse(
        c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`)!,
      ).payload,
    ).toBe(original);
    expect(store.status().migration).not.toBe("verified");
  });

  it("uses only this identity’s previous cache during an explicit network failure", async () => {
    const c = cacheFixture(),
      r = remoteFixture(JSON.stringify(preservedState()));
    await create(ADMIN, r.remote, c.cache).store.loadState();
    vi.mocked(r.remote.migrationStatus).mockRejectedValue(
      new AccountStoreError("NETWORK_ERROR", "Offline"),
    );
    const offline = create(ADMIN, r.remote, c.cache).store;
    expect(await offline.loadState()).toEqual(preservedState());
    expect(offline.status()).toMatchObject({
      loaded: true,
      offline: true,
      dirty: false,
    });
    await expect(
      create(OTHER, r.remote, c.cache).store.loadState(),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it.each(["AUTH_ERROR", "PERMISSION_ERROR", "CORRUPT_DATA"] as const)(
    "does not treat %s as offline or return private cached state",
    async (code) => {
      const c = cacheFixture(),
        r = remoteFixture(JSON.stringify(preservedState()));
      await create(ADMIN, r.remote, c.cache).store.loadState();
      vi.mocked(r.remote.load).mockRejectedValue(
        new AccountStoreError(code, "Backend refused this request"),
      );
      const next = create(ADMIN, r.remote, c.cache).store;
      await expect(next.loadState()).rejects.toMatchObject({ code });
      expect(next.status().loaded).toBe(false);
      expect(c.values.has(`${ACCOUNT_CACHE_PREFIX}${ADMIN}`)).toBe(true);
    },
  );

  it("retains dirty local edits offline and reconciles them with revision compare-and-swap on reconnect", async () => {
    const c = cacheFixture(),
      r = remoteFixture(JSON.stringify(initialState()));
    const store = create(OTHER, r.remote, c.cache).store;
    await store.loadState();
    vi.mocked(r.remote.save).mockRejectedValueOnce(
      new AccountStoreError("NETWORK_ERROR", "Offline"),
    );
    const own = preservedState();
    await store.saveState(own);
    expect(store.status()).toMatchObject({
      offline: true,
      dirty: true,
      revision: 1,
    });
    expect(await create(OTHER, r.remote, c.cache).store.loadState()).toEqual(
      own,
    );
    expect(r.remote.save).toHaveBeenLastCalledWith(JSON.stringify(own), 1);
    expect(
      JSON.parse(c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)!).dirty,
    ).toBe(false);
  });

  it("recovers a successful save whose response was lost without duplicating the revision", async () => {
    const c = cacheFixture(),
      r = remoteFixture();
    const originalSave = vi.mocked(r.remote.save).getMockImplementation()!;
    vi.mocked(r.remote.save).mockImplementationOnce(
      async (payload, revision) => {
        // Store remotely using the fixture's original implementation, then lose the response.
        await originalSave(payload, revision);
        throw new AccountStoreError("NETWORK_ERROR", "Response lost");
      },
    );
    const store = create(OTHER, r.remote, c.cache).store;
    await store.loadState();
    const own = preservedState();
    await store.saveState(own);
    const recovered = create(OTHER, r.remote, c.cache).store;
    expect(await recovered.loadState()).toEqual(own);
    expect(r.revision()).toBe(1);
    expect(r.remote.save).toHaveBeenCalledOnce();
    expect(recovered.status().dirty).toBe(false);
  });

  it("preserves pending local changes on a conflict rather than overwriting another revision", async () => {
    const c = cacheFixture(),
      r = remoteFixture(JSON.stringify(initialState()));
    const store = create(OTHER, r.remote, c.cache).store;
    await store.loadState();
    const newer = initialState();
    newer.settings.name = "Changed elsewhere";
    await r.remote.save(JSON.stringify(newer), 1);
    const local = preservedState();
    await expect(store.saveState(local)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      create(OTHER, r.remote, c.cache).store.loadState(),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(r.payload()).toBe(JSON.stringify(newer));
    const retained = JSON.parse(
      c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)!,
    );
    expect(retained).toMatchObject({
      dirty: true,
      payload: JSON.stringify(local),
      revision: 1,
    });
  });

  it("captures queued saves before caller mutation and writes consecutive revisions", async () => {
    const c = cacheFixture(),
      r = remoteFixture();
    const store = create(OTHER, r.remote, c.cache).store;
    await store.loadState();
    const first = initialState();
    first.settings.name = "First captured value";
    const p1 = store.saveState(first);
    first.settings.name = "Later accidental mutation";
    const second = initialState();
    second.settings.name = "Second captured value";
    const p2 = store.saveState(second);
    await Promise.all([p1, p2]);
    expect(
      JSON.parse(vi.mocked(r.remote.save).mock.calls[0][0]).settings.name,
    ).toBe("First captured value");
    expect(vi.mocked(r.remote.save).mock.calls.map((call) => call[1])).toEqual([
      0, 1,
    ]);
    expect(r.revision()).toBe(2);
  });

  it("resets only the active owner’s snapshot and keeps the original migration backup", async () => {
    const c = cacheFixture(),
      r = remoteFixture(),
      original = JSON.stringify(preservedState());
    r.eligible();
    const store = create(ADMIN, r.remote, c.cache, original).store;
    await store.loadState();
    const other = remoteFixture(original);
    await create(OTHER, other.remote, c.cache).store.loadState();
    await store.deleteState();
    expect(JSON.parse(r.payload()!)).toEqual(initialState());
    expect(
      JSON.parse(
        c.values.get(`${ACCOUNT_CACHE_PREFIX}${ADMIN}:legacy-backup:v1`)!,
      ).payload,
    ).toBe(original);
    expect(
      JSON.parse(c.values.get(`${ACCOUNT_CACHE_PREFIX}${OTHER}`)!).payload,
    ).toBe(original);
  });

  it("does not create defaults when load failed and does not allow an unloaded store to save", async () => {
    const c = cacheFixture(),
      r = remoteFixture();
    vi.mocked(r.remote.load).mockRejectedValue(
      new Error("Unexpected backend failure"),
    );
    const store = create(OTHER, r.remote, c.cache).store;
    await expect(store.loadState()).rejects.toThrow(
      "Unexpected backend failure",
    );
    await expect(store.saveState(initialState())).rejects.toMatchObject({
      code: "NOT_LOADED",
    });
    expect(c.values.size).toBe(0);
    expect(r.remote.save).not.toHaveBeenCalled();
  });

  it("recovers a completed migration whose initial response was lost by verifying the retained backup", async () => {
    const c = cacheFixture(),
      r = remoteFixture(),
      original = JSON.stringify(preservedState());
    r.eligible();
    const originalMigrate = vi
      .mocked(r.remote.migrate)
      .getMockImplementation()!;
    vi.mocked(r.remote.migrate).mockImplementationOnce(
      async (payload, digest) => {
        await originalMigrate(payload, digest);
        throw new AccountStoreError("NETWORK_ERROR", "Migration response lost");
      },
    );
    await expect(
      create(ADMIN, r.remote, c.cache, original).store.loadState(),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    const recovered = create(ADMIN, r.remote, c.cache, original);
    expect(await recovered.store.loadState()).toEqual(preservedState());
    expect(recovered.readLegacy).not.toHaveBeenCalled();
    expect(recovered.store.status().migration).toBe("verified");
    expect(r.remote.migrate).toHaveBeenCalledOnce();
  });

  it("serialises an earlier store's save before a remounted store loads the same owner", async () => {
    const c = cacheFixture(),
      r = remoteFixture();
    const first = create(OTHER, r.remote, c.cache).store;
    await first.loadState();
    const originalSave = vi.mocked(r.remote.save).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(r.remote.save).mockImplementationOnce(
      async (payload, revision) => {
        await gate;
        return originalSave(payload, revision);
      },
    );
    const pendingSave = first.saveState(preservedState());
    const reload = create(OTHER, r.remote, c.cache).store.loadState();
    release();
    await pendingSave;
    expect(await reload).toEqual(preservedState());
    expect(r.revision()).toBe(1);
  });
});
