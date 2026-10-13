import { describe, expect, it, vi } from "vitest";
import {
  accountCacheKeysToDelete,
  deleteOwnAccount,
  type AccountDeletionDependencies,
} from "../src/auth/deleteAccount";
import {
  createAccountDeletionHandler,
  deletionIdentityFromVerifiedClaims,
  type DeletionDependencies,
} from "../supabase/functions/wakey-delete-account/handler";

const A = "10000000-0000-4000-8000-000000000011";
const B = "10000000-0000-4000-8000-000000000012";
const NOW = Date.UTC(2026, 9, 13, 12);
describe("verified provider claims for deletion", () => {
  const user = {
    id: A,
    email_confirmed_at: "2026-10-13T00:00:00Z",
    is_anonymous: false,
  };
  const claims = {
    sub: A,
    role: "authenticated",
    exp: NOW / 1000 + 3600,
    amr: [{ method: "password", timestamp: NOW / 1000 - 10 }],
  };
  it("accepts password claims after cryptographic/provider checks", () => {
    expect(deletionIdentityFromVerifiedClaims(user, claims, NOW)).toEqual({
      id: A,
      passwordAuthenticatedAt: NOW / 1000 - 10,
    });
  });
  it.each([
    { sub: B },
    { role: "service_role" },
    { exp: NOW / 1000 },
    { exp: "unexpected" },
    { client_id: "external-client" },
    { amr: [] },
    { amr: [{ method: "recovery", timestamp: NOW / 1000 }] },
    { amr: [{ method: "password", timestamp: "unexpected" }] },
    { amr: [null] },
    { amr: [{ method: "password", timestamp: Number.NaN }] },
  ])(
    "rejects mismatched, expired, delegated or malformed claims: %j",
    (changed) => {
      expect(
        deletionIdentityFromVerifiedClaims(
          user,
          { ...claims, ...changed },
          NOW,
        ),
      ).toBeNull();
    },
  );
  it("rejects unverified and anonymous accounts", () => {
    expect(
      deletionIdentityFromVerifiedClaims(
        { ...user, email_confirmed_at: undefined },
        claims,
        NOW,
      ),
    ).toBeNull();
    expect(
      deletionIdentityFromVerifiedClaims(
        { ...user, is_anonymous: true },
        claims,
        NOW,
      ),
    ).toBeNull();
  });
});
const client = (): AccountDeletionDependencies => ({
  currentUserId: vi.fn(async () => A),
  reauthenticate: vi.fn(async () => ({
    userId: A,
    token: "temporary-fixture-token",
  })),
  deleteRemote: vi.fn(async () => undefined),
  releaseSession: vi.fn(async () => undefined),
});
const input = {
  userId: A,
  email: "owner@example.invalid",
  password: "existing-fixture-password",
  confirmation: "DELETE",
};

describe("explicit own-account deletion", () => {
  it("checks confirmation before sending a password or making a deletion request", async () => {
    const deps = client();
    await expect(
      deleteOwnAccount({ ...input, confirmation: "delete" }, deps),
    ).rejects.toThrow("Type DELETE");
    expect(deps.reauthenticate).not.toHaveBeenCalled();
    expect(deps.deleteRemote).not.toHaveBeenCalled();
  });
  it("deletes only after same-owner reauthentication and does not send the password to deletion", async () => {
    const deps = client();
    await deleteOwnAccount(input, deps);
    expect(deps.reauthenticate).toHaveBeenCalledWith(
      input.email,
      input.password,
    );
    expect(deps.deleteRemote).toHaveBeenCalledWith("temporary-fixture-token");
    expect(deps.releaseSession).not.toHaveBeenCalled();
  });
  it("rejects an already changed account without reauthentication", async () => {
    const deps = client();
    deps.currentUserId = vi.fn(async () => B);
    await expect(deleteOwnAccount(input, deps)).rejects.toThrow(
      "active account changed",
    );
    expect(deps.reauthenticate).not.toHaveBeenCalled();
  });
  it("rejects another owner returned by Auth and releases that temporary session", async () => {
    const deps = client();
    deps.reauthenticate = vi.fn(async () => ({
      userId: B,
      token: "wrong-owner-fixture",
    }));
    await expect(deleteOwnAccount(input, deps)).rejects.toThrow(
      "active account changed",
    );
    expect(deps.deleteRemote).not.toHaveBeenCalled();
    expect(deps.releaseSession).toHaveBeenCalledWith("wrong-owner-fixture");
  });
  it("rejects an account switch while password confirmation was pending", async () => {
    const deps = client();
    deps.currentUserId = vi
      .fn()
      .mockResolvedValueOnce(A)
      .mockResolvedValueOnce(B);
    await expect(deleteOwnAccount(input, deps)).rejects.toThrow(
      "active account changed",
    );
    expect(deps.deleteRemote).not.toHaveBeenCalled();
    expect(deps.releaseSession).toHaveBeenCalledOnce();
  });
  it("releases the temporary session after an unconfirmed remote deletion", async () => {
    const deps = client();
    deps.deleteRemote = vi.fn(async () => {
      throw new Error("network-failure");
    });
    await expect(deleteOwnAccount(input, deps)).rejects.toThrow(
      "network-failure",
    );
    expect(deps.releaseSession).toHaveBeenCalledOnce();
  });
  it("purges only exact owner cache/legacy/recovery keys", () => {
    const key = `wakey-wakey:account:v1:${A}`;
    const owned = [
      key,
      `${key}:legacy-backup:v1`,
      `${key}:conflict-backup:v1:device:hash`,
    ];
    expect(
      accountCacheKeysToDelete(
        [
          ...owned,
          `${key}suffix`,
          `wakey-wakey:account:v1:${B}`,
          "wakey-wakey:auth:v1",
          "wakey-wakey-state",
        ],
        A,
      ),
    ).toEqual(owned);
  });
});

const server = (): DeletionDependencies => ({
  now: () => NOW,
  identity: vi.fn(async () => ({
    id: A,
    passwordAuthenticatedAt: NOW / 1000 - 30,
  })),
  revokeSessions: vi.fn(async () => undefined),
  hardDelete: vi.fn(async () => undefined),
});
const request = (
  body: object = { confirmation: "DELETE" },
  origin?: string,
  token = true,
) =>
  new Request("https://backend.example.invalid/wakey-delete-account", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer fixture-token" } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
describe("secured deletion handler", () => {
  it("allows native requests, revokes sessions, then deletes the verified owner", async () => {
    const deps = server();
    const response = await createAccountDeletionHandler(deps)(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(deps.hardDelete).toHaveBeenCalledWith(A);
    expect(
      vi.mocked(deps.revokeSessions).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(deps.hardDelete).mock.invocationCallOrder[0]);
  });
  it("allows the hosted website with no tracking/caching headers", async () => {
    const response = await createAccountDeletionHandler(server())(
      request(undefined, "https://morecreationapps.github.io"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    { confirmation: "DELETE", userId: B },
    { confirmation: "DELETE", email: "other@example.invalid" },
    { confirmation: "DELETE", password: "should-not-be-sent" },
    { confirmation: "NO" },
  ])(
    "rejects supplied target IDs/details or absent confirmation: %j",
    async (body) => {
      const deps = server();
      const response = await createAccountDeletionHandler(deps)(request(body));
      expect(response.status).toBe(400);
      expect(deps.hardDelete).not.toHaveBeenCalled();
    },
  );
  it.each([NOW / 1000 - 301, NOW / 1000 + 31, Number.NaN])(
    "rejects stale/future/malformed password authentication: %s",
    async (at) => {
      const deps = server();
      deps.identity = vi.fn(async () => ({
        id: A,
        passwordAuthenticatedAt: at,
      }));
      const response = await createAccountDeletionHandler(deps)(request());
      expect(response.status).toBe(401);
      expect(deps.revokeSessions).not.toHaveBeenCalled();
    },
  );
  it("rejects missing/invalid auth without deletion", async () => {
    const deps = server();
    const response = await createAccountDeletionHandler(deps)(
      request(undefined, undefined, false),
    );
    expect(response.status).toBe(401);
    expect(deps.identity).not.toHaveBeenCalled();
    expect(deps.hardDelete).not.toHaveBeenCalled();
  });
  it("rejects unrelated browser origins before accessing Auth", async () => {
    const deps = server();
    const response = await createAccountDeletionHandler(deps)(
      request(undefined, "https://unrelated.example.invalid"),
    );
    expect(response.status).toBe(403);
    expect(deps.identity).not.toHaveBeenCalled();
  });
  it("does not delete when session revocation fails and suppresses provider internals", async () => {
    const deps = server();
    deps.revokeSessions = vi.fn(async () => {
      throw new Error("private provider internals");
    });
    const response = await createAccountDeletionHandler(deps)(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private provider");
    expect(deps.hardDelete).not.toHaveBeenCalled();
  });
  it("fails closed on malformed input", async () => {
    const deps = server();
    const response = await createAccountDeletionHandler(deps)(
      new Request("https://backend.example.invalid", {
        method: "POST",
        body: "broken json",
      }),
    );
    expect(response.status).toBe(503);
    expect(deps.identity).not.toHaveBeenCalled();
  });
});
