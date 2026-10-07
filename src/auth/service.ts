import "react-native-url-polyfill/auto";
import { createClient, type Session } from "@supabase/supabase-js";
import { AppState as NativeAppState, Platform } from "react-native";
import * as Crypto from "expo-crypto";
import { sessionStorage } from "../platform/sessionStorage";
import type { AuthProvider, AccountIdentity } from "./controller";
import {
  AccountStoreError,
  accountAccessError,
  type AccountRemote,
} from "./accountStore";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
export const authenticationConfigured =
  /^https:\/\/[a-z\d-]+\.supabase\.co$/.test(url) &&
  key.startsWith("sb_publishable_") &&
  process.env.EXPO_PUBLIC_AUTH_EMAIL_CONFIGURED === "true";
export const supabase = authenticationConfigured
  ? createClient(url, key, {
      auth: {
        storage: sessionStorage,
        storageKey: "wakey-wakey:auth:v1",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
function client() {
  if (!supabase)
    throw Object.assign(
      new Error("Account service configuration is incomplete"),
      { code: "CONFIGURATION" },
    );
  return supabase;
}
const fail = (error: unknown) => {
  if (error) throw error;
};
let offlineIdentity: { identity: AccountIdentity; token: string } | null = null;
function networkError(error: unknown) {
  return (
    error instanceof TypeError ||
    (error as { name?: string })?.name === "AuthRetryableFetchError"
  );
}
async function verifiedIdentity(session: Session): Promise<AccountIdentity> {
  const {
    data: { user },
    error,
  } = await client().auth.getUser(session.access_token);
  fail(error);
  if (!user?.email_confirmed_at || user.is_anonymous || !user.email)
    throw Object.assign(new Error("Email verification is required"), {
      code: "email_not_confirmed",
    });
  const result = await client().auth.getClaims(session.access_token);
  fail(result.error);
  const claims = result.data?.claims;
  const amr = claims?.amr as Array<{ method?: string }> | undefined;
  if (
    claims?.sub !== user.id ||
    !Array.isArray(amr) ||
    amr.length === 0 ||
    !amr.every((item) => item.method === "password") ||
    !!claims?.client_id
  )
    throw Object.assign(new Error("A password login is required"), {
      code: "PASSWORD_SESSION_REQUIRED",
    });
  const expiresAt = Number(claims?.exp) * 1000;
  if (!(expiresAt > Date.now()))
    throw Object.assign(new Error("Session expired"), { code: "AUTH_ERROR" });
  const identity = { id: user.id, email: user.email, expiresAt };
  offlineIdentity = { identity, token: session.access_token };
  return identity;
}
export const authProvider: AuthProvider = {
  ready: authenticationConfigured,
  configurationMessage:
    "Account setup is incomplete. The authentication backend and verified email sender must be configured before you can log in. No email has been sent. Your existing device data has been retained.",
  async restore() {
    const {
      data: { session },
      error,
    } = await client().auth.getSession();
    fail(error);
    if (!session) return null;
    try {
      return await verifiedIdentity(session);
    } catch (error) {
      // Offline access is bounded to a still-valid token that this running app
      // previously validated online. A cold offline start never trusts a cache.
      if (
        networkError(error) &&
        offlineIdentity?.token === session.access_token &&
        offlineIdentity.identity.expiresAt > Date.now()
      )
        return offlineIdentity.identity;
      throw error;
    }
  },
  async login(email, password) {
    const { data, error } = await client().auth.signInWithPassword({
      email,
      password,
    });
    fail(error);
    if (!data.session) throw new Error("No password session was returned");
    return verifiedIdentity(data.session);
  },
  async signup(email, password) {
    const { data, error } = await client().auth.signUp({ email, password });
    fail(error);
    // Confirmation must be enabled on the server. Fail closed if misconfigured.
    if (data.session) {
      await client().auth.signOut({ scope: "local" });
      throw Object.assign(
        new Error("Email confirmation is disabled on the server"),
        { code: "CONFIGURATION" },
      );
    }
  },
  async verify(email, token, purpose) {
    const { error } = await client().auth.verifyOtp({
      email,
      token,
      type: purpose,
    });
    fail(error);
  },
  async resend(email) {
    const { error } = await client().auth.resend({ type: "signup", email });
    fail(error);
  },
  async recover(email) {
    const { error } = await client().auth.resetPasswordForEmail(email);
    fail(error);
  },
  async updatePassword(password) {
    const { error } = await client().auth.updateUser({ password });
    fail(error);
  },
  async logout() {
    offlineIdentity = null;
    if (!supabase) return;
    const { error } = await supabase.auth.signOut({ scope: "local" });
    // Always clear this device's session even when revocation cannot reach server.
    await sessionStorage.removeItem("wakey-wakey:auth:v1");
    fail(error);
  },
  listen(callback) {
    if (!supabase) return () => {};
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") callback(event, session);
      else setTimeout(() => callback(event, session), 0);
    });
    let native: ReturnType<typeof NativeAppState.addEventListener> | undefined;
    if (Platform.OS !== "web") {
      supabase.auth.startAutoRefresh();
      native = NativeAppState.addEventListener("change", (phase) => {
        if (phase === "active") supabase.auth.startAutoRefresh();
        else supabase.auth.stopAutoRefresh();
      });
    }
    return () => {
      subscription.unsubscribe();
      native?.remove();
      if (Platform.OS !== "web") supabase.auth.stopAutoRefresh();
    };
  },
};
export const hashSnapshot = (payload: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);
export function accountRemote(userId: string): AccountRemote {
  async function rpc<T>(
    name: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const {
      data: { session },
      error,
    } = await client().auth.getSession();
    if (
      error ||
      !session ||
      session.user.id !== userId ||
      (session.expires_at ?? 0) * 1000 <= Date.now()
    )
      throw new AccountStoreError(
        "AUTH_ERROR",
        "Log in again to synchronise this account.",
      );
    // Capture this owner's bearer token. A switch while fetch is pending cannot
    // accidentally submit the old planner using the new account's credentials.
    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AccountStoreError(
        "NETWORK_ERROR",
        "The server could not be reached. Saved changes remain on this device.",
      );
    }
    const result = await response.json();
    if (!response.ok) {
      const accessError = accountAccessError(response.status, result);
      if (accessError) throw accessError;
      if (response.status === 409 || result.code === "40001")
        throw new AccountStoreError(
          "CONFLICT",
          "Newer settings exist on the server. Your device changes have been retained; refresh before making further changes.",
        );
      if (response.status >= 500)
        throw new AccountStoreError(
          "NETWORK_ERROR",
          "The server is temporarily unavailable. Saved changes remain on this device.",
        );
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "The server rejected this planner update. Existing saved records have been retained.",
      );
    }
    return result as T;
  }
  return {
    load: () => rpc("planner_load"),
    save: (payload, expected) =>
      rpc("planner_save", {
        p_payload: payload,
        p_expected_revision: expected,
      }),
    migrationStatus: () => rpc("planner_migration_status"),
    migrate: (payload, digest) =>
      rpc("planner_migrate_legacy", { p_payload: payload, p_digest: digest }),
  };
}
