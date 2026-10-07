import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import {
  ManagedAuth,
  authMessage,
  type AccountIdentity,
  type AuthProvider,
} from "../src/auth/controller";

// Provider mocks exist only in this test file. These checks exercise the app's
// auth decisions; they do not claim email delivery or provider OTP security.
const email = "test-user@example.test";
const password = "  A long pasted password  ";
const confirmedIdentity = (): AccountIdentity => ({
  id: "verified-account-a",
  email,
  expiresAt: Date.now() + 3_600_000,
});

function provider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    ready: true,
    configurationMessage: "",
    restore: vi.fn(async () => null),
    login: vi.fn(async () => confirmedIdentity()),
    signup: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    resend: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    listen: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("managed email and password authentication", () => {
  it("keeps signup unverified, then requires normal password login after confirming the code", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    auth.show("signup");

    await auth.signup(` ${email} `, password, password);

    expect(service.signup).toHaveBeenCalledWith(email, password);
    expect(service.login).not.toHaveBeenCalled();
    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("verify");
    expect(auth.view.email).toBe(email);
    expect(auth.view.message).toContain("Delivery has not been confirmed");
    expect(auth.view.resendAt).toBe(Date.now() + 60_000);

    await auth.verify("1234 5678");

    expect(service.verify).toHaveBeenCalledWith(email, "12345678", "signup");
    expect(service.logout).toHaveBeenCalledOnce();
    expect(service.login).toHaveBeenCalledExactlyOnceWith(email, password);
    expect(vi.mocked(service.verify).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(service.logout).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(service.logout).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(service.login).mock.invocationCallOrder[0],
    );
    expect(auth.identity?.id).toBe("verified-account-a");
    expect(auth.view.error).toBe("");
  });

  it("rejects short and mismatched new passwords without contacting the provider", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    auth.show("signup");

    await auth.signup(email, "12345678901", "12345678901");
    expect(auth.view.error).toContain("at least 12 characters");
    await auth.signup(email, password, `${password}different`);
    expect(auth.view.error).toContain("do not match");
    expect(service.signup).not.toHaveBeenCalled();
    expect(auth.identity).toBeNull();

    await auth.signup(email, "123456789012", "123456789012");
    expect(service.signup).toHaveBeenCalledExactlyOnceWith(
      email,
      "123456789012",
    );
  });

  it("routes an unverified password login to confirmation without creating an identity", async () => {
    const service = provider({
      login: vi.fn().mockRejectedValue({ code: "email_not_confirmed" }),
    });
    const auth = new ManagedAuth(service);
    auth.show("login");

    await auth.login(email, password);

    expect(service.login).toHaveBeenCalledWith(email, password);
    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("verify");
    expect(auth.view.email).toBe(email);
    expect(auth.view.message).toContain("Verify this email address");
    expect(service.resend).not.toHaveBeenCalled();
  });

  it("keeps rejected codes unverified and maps incorrect, expired or already-used codes clearly", async () => {
    const service = provider({
      verify: vi.fn().mockRejectedValue({ code: "otp_expired", status: 403 }),
    });
    const auth = new ManagedAuth(service);
    await auth.signup(email, password, password);

    await auth.verify("12345678");
    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("verify");
    expect(auth.view.error).toContain("incorrect, expired or already used");
    expect(service.login).not.toHaveBeenCalled();

    await auth.verify("12345678");
    expect(service.verify).toHaveBeenCalledTimes(2);
    expect(auth.identity).toBeNull();
    expect(auth.view.error).toContain("incorrect, expired or already used");
    expect(service.login).not.toHaveBeenCalled();

    await auth.verify("not-a-code");
    expect(service.verify).toHaveBeenCalledTimes(2);
    expect(auth.view.error).toContain("numeric code");
    expect(auth.identity).toBeNull();
  });

  it("enforces the resend cooldown and surfaces a backend rate limit without implying delivery", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    await auth.signup(email, password, password);

    await auth.resend();
    expect(service.resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    await auth.resend();
    expect(service.resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await auth.resend();
    expect(service.resend).toHaveBeenCalledExactlyOnceWith(email);
    expect(auth.view.message).toContain("cannot confirm delivery");
    expect(auth.view.resendAt).toBe(Date.now() + 60_000);

    vi.mocked(service.resend).mockRejectedValueOnce({ status: 429 });
    vi.advanceTimersByTime(60_000);
    await auth.resend();
    expect(auth.view.error).toContain("Too many attempts");
    expect(auth.view.error).toContain("limited by the server");
    expect(auth.view.message).toBe("");
    expect(auth.identity).toBeNull();
  });

  it("corrects the destination through signup without rewriting the old pending registration", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    await auth.signup(email, password, password);

    auth.correctEmail();

    expect(auth.view.screen).toBe("signup");
    expect(auth.view.message).toContain(
      "previous unverified registration is retained",
    );
    expect(auth.identity).toBeNull();
    expect(service.signup).toHaveBeenCalledOnce();
    expect(service.updatePassword).not.toHaveBeenCalled();
  });

  it("preserves a signup failure when the already-selected signup tab is activated", async () => {
    const service = provider({
      signup: vi
        .fn()
        .mockRejectedValue({ code: "email_address_not_authorized" }),
    });
    const auth = new ManagedAuth(service);
    auth.show("signup");
    await auth.signup(email, password, password);
    const failed = auth.getSnapshot();
    expect(failed.view.error).toContain("email service could not complete");
    const listener = vi.fn();
    const unsubscribe = auth.subscribe(listener);

    auth.show("signup");

    expect(auth.getSnapshot()).toBe(failed);
    expect(listener).not.toHaveBeenCalled();
    expect(service.signup).toHaveBeenCalledOnce();
    expect(auth.identity).toBeNull();

    auth.show("login");
    expect(auth.view.screen).toBe("login");
    expect(auth.view.error).toBe("");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("retains the signup screen after a mail failure without claiming a code was requested or establishing identity", async () => {
    const service = provider({
      signup: vi.fn().mockRejectedValue({
        code: "unexpected_failure",
        status: 500,
        message: "Error sending confirmation email",
      }),
    });
    const auth = new ManagedAuth(service);
    auth.show("signup");

    await auth.signup(email, password, password);

    expect(service.signup).toHaveBeenCalledExactlyOnceWith(email, password);
    expect(auth.view.screen).toBe("signup");
    expect(auth.view.busy).toBe(false);
    expect(auth.view.message).toBe("");
    expect(auth.view.resendAt).toBe(0);
    expect(auth.view.error).toContain("could not send a code");
    expect(auth.identity).toBeNull();
    expect(service.login).not.toHaveBeenCalled();
    expect(service.verify).not.toHaveBeenCalled();
    expect(service.resend).not.toHaveBeenCalled();
  });

  it("cannot use a confirmation code as an alternative login after leaving verification", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    // Navigating away clears the in-memory password. A stale code submission
    // from the old screen must not become an alternative login method.
    vi.mocked(service.login).mockRejectedValueOnce({
      code: "email_not_confirmed",
    });
    await auth.login(email, password);
    auth.show("login");

    await auth.verify("12345678");

    expect(service.verify).not.toHaveBeenCalled();
    expect(service.login).toHaveBeenCalledOnce();
    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
    expect(auth.view.error).not.toBe("");
  });

  it("clears an authenticated identity on logout while preserving a provider failure message", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    await auth.login(email, password);
    expect(auth.identity).not.toBeNull();
    vi.mocked(service.logout).mockRejectedValueOnce({ code: "NETWORK_ERROR" });

    await auth.logout();

    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
    expect(auth.view.message).toContain("saved planner has been retained");
    expect(auth.view.error).toContain("Check your connection");
  });

  it("does not start another account's login until provider logout cleanup finishes", async () => {
    const pendingLogout = deferred<void>();
    let onEvent!: (event: string, session: Session | null) => void;
    const otherEmail = "next-user@example.test";
    const service = provider({
      logout: vi.fn(() => pendingLogout.promise),
      login: vi.fn(async (destination) => ({
        ...confirmedIdentity(),
        id: destination === email ? "verified-account-a" : "verified-account-b",
        email: destination,
      })),
      listen: vi.fn((callback) => {
        onEvent = callback;
        return () => undefined;
      }),
    });
    const auth = new ManagedAuth(service);
    const stop = auth.start();
    await auth.restore();
    await auth.login(email, password);
    const loggingOut = auth.logout();
    expect(auth.identity).toBeNull();
    expect(auth.view.busy).toBe(true);

    // Supabase emits this before the service's final storage cleanup returns.
    onEvent("SIGNED_OUT", null);
    expect(auth.view.busy).toBe(true);
    await auth.login(otherEmail, password);
    auth.show("signup");
    expect(service.login).toHaveBeenCalledTimes(1);
    expect(auth.view.screen).toBe("login");

    pendingLogout.resolve();
    await loggingOut;
    expect(auth.view.busy).toBe(false);
    await auth.login(otherEmail, password);
    expect(service.login).toHaveBeenCalledTimes(2);
    expect(auth.identity).toMatchObject({
      id: "verified-account-b",
      email: otherEmail,
    });
    stop();
  });

  it("does not restore the previous account from a request that completes after logout", async () => {
    const pending = deferred<AccountIdentity | null>();
    const service = provider({ restore: vi.fn(() => pending.promise) });
    const auth = new ManagedAuth(service);
    const restoration = auth.restore();

    await auth.logout();
    pending.resolve(confirmedIdentity());
    await restoration;

    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
  });

  it("does not reopen the previous account when an in-flight password login completes after logout", async () => {
    const pending = deferred<AccountIdentity>();
    const service = provider({ login: vi.fn(() => pending.promise) });
    const auth = new ManagedAuth(service);
    auth.show("login");
    const login = auth.login(email, password);

    await auth.logout();
    pending.resolve(confirmedIdentity());
    await login;

    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
  });

  it("hides private identity when the provider announces sign-out", async () => {
    let onEvent!: (event: string, session: Session | null) => void;
    const service = provider({
      listen: vi.fn((callback) => {
        onEvent = callback;
        return () => undefined;
      }),
    });
    const auth = new ManagedAuth(service);
    const stop = auth.start();
    await auth.restore();
    await auth.login(email, password);
    expect(auth.identity).not.toBeNull();

    onEvent("SIGNED_OUT", null);

    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
    stop();
  });

  it("never calls an unconfigured provider or pretends an email was sent", async () => {
    const service = provider({
      ready: false,
      configurationMessage: "Configure the real account and email services.",
    });
    const auth = new ManagedAuth(service);
    expect(auth.view.screen).toBe("configuration");
    expect(auth.view.message).toContain("Configure the real");

    await auth.signup(email, password, password);
    await auth.requestRecovery(email);

    expect(service.signup).not.toHaveBeenCalled();
    expect(service.recover).not.toHaveBeenCalled();
    expect(auth.view.error).toContain(
      "No verification or recovery email has been sent",
    );
    expect(auth.identity).toBeNull();
  });
});

describe("password recovery remains separate from login", () => {
  it("retains the forgot-password screen after a mail failure without entering code recovery", async () => {
    const service = provider({
      recover: vi.fn().mockRejectedValue({
        code: "unexpected_failure",
        status: 500,
        message: "Error sending recovery email",
      }),
    });
    const auth = new ManagedAuth(service);
    auth.show("forgot");

    await auth.requestRecovery(email);

    expect(service.recover).toHaveBeenCalledExactlyOnceWith(email);
    expect(auth.view.screen).toBe("forgot");
    expect(auth.view.busy).toBe(false);
    expect(auth.view.message).toBe("");
    expect(auth.view.resendAt).toBe(0);
    expect(auth.view.error).toContain("could not send a code");
    expect(auth.identity).toBeNull();
    expect(service.verify).not.toHaveBeenCalled();
    expect(service.updatePassword).not.toHaveBeenCalled();
  });

  it("keeps recovery tokens out of identity, enforces recovery resend cooldown, and requires normal login after reset", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);
    auth.show("forgot");

    await auth.requestRecovery(email);
    expect(service.recover).toHaveBeenCalledExactlyOnceWith(email);
    expect(auth.view.screen).toBe("recovery");
    expect(auth.view.message).toContain("If this address can receive");
    expect(auth.identity).toBeNull();
    await auth.resend();
    expect(service.recover).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    await auth.resend();
    expect(service.recover).toHaveBeenCalledTimes(2);
    expect(service.resend).not.toHaveBeenCalled();

    await auth.verifyRecovery("87654321");
    expect(service.verify).toHaveBeenCalledWith(email, "87654321", "recovery");
    expect(auth.view.screen).toBe("reset");
    expect(auth.identity).toBeNull();
    expect(service.login).not.toHaveBeenCalled();

    const replacement = "  Another long password  ";
    await auth.resetPassword(replacement, replacement);
    expect(service.updatePassword).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(service.logout).toHaveBeenCalledOnce();
    expect(auth.identity).toBeNull();
    expect(auth.view.screen).toBe("login");
    expect(auth.view.message).toContain(
      "Log in with your email and new password",
    );
    expect(service.login).not.toHaveBeenCalled();

    await auth.login(email, replacement);
    expect(service.login).toHaveBeenCalledExactlyOnceWith(email, replacement);
    expect(auth.identity?.id).toBe("verified-account-a");
  });

  it("cannot set a password without verified recovery or with an invalid confirmation", async () => {
    const service = provider();
    const auth = new ManagedAuth(service);

    await auth.resetPassword(password, password);
    expect(service.updatePassword).not.toHaveBeenCalled();
    expect(auth.identity).toBeNull();

    await auth.requestRecovery(email);
    await auth.verifyRecovery("87654321");
    await auth.resetPassword("12345678901", "12345678901");
    expect(auth.view.error).toContain("at least 12 characters");
    await auth.resetPassword(password, "different password");
    expect(auth.view.error).toContain("do not match");
    expect(service.updatePassword).not.toHaveBeenCalled();
    expect(auth.identity).toBeNull();
  });

  it("keeps recovery code failures outside protected views", async () => {
    const service = provider({
      verify: vi.fn().mockRejectedValue({ code: "otp_expired" }),
    });
    const auth = new ManagedAuth(service);
    await auth.requestRecovery(email);

    await auth.verifyRecovery("87654321");
    expect(auth.view.screen).toBe("recovery");
    expect(auth.view.error).toContain("incorrect, expired or already used");
    expect(auth.identity).toBeNull();
    await auth.resetPassword(password, password);
    expect(service.updatePassword).not.toHaveBeenCalled();
    expect(service.login).not.toHaveBeenCalled();
  });
});

describe("public auth error messages", () => {
  it.each(["Error sending confirmation email", "Error sending recovery email"])(
    "gives safe delivery guidance for the known provider mail error: %s",
    (message) => {
      const result = authMessage({
        code: "unexpected_failure",
        status: 500,
        message,
      });
      expect(result).toContain("email service could not send a code");
      expect(result).toContain("contact support");
      expect(result).toContain("saved planner has been retained");
      expect(result).not.toContain(message);
    },
  );

  it.each([
    "Database error saving new user",
    undefined,
    "535 Authentication credentials invalid: private-smtp-detail",
  ])(
    "keeps unrelated unexpected failures generic and suppresses provider details: %s",
    (message) => {
      const result = authMessage({
        code: "unexpected_failure",
        status: 500,
        message,
      });
      expect(result).toBe(
        "The account service could not complete this request. Please try again. Your saved planner has been retained.",
      );
      expect(result).not.toContain("email service");
      expect(result).not.toContain("private-smtp-detail");
    },
  );

  it("requires the expected provider error code before giving mail-specific guidance", () => {
    expect(
      authMessage({
        code: "other_failure",
        status: 500,
        message: "Error sending confirmation email",
      }),
    ).toBe(
      "The account service could not complete this request. Please try again. Your saved planner has been retained.",
    );
  });

  it("requires the expected provider server status before giving mail-specific guidance", () => {
    expect(
      authMessage({
        code: "unexpected_failure",
        status: 422,
        message: "Error sending confirmation email",
      }),
    ).toBe(
      "The account service could not complete this request. Please try again. Your saved planner has been retained.",
    );
  });

  it("does not disclose whether an email is registered when credentials are rejected", () => {
    expect(authMessage({ code: "user_not_found" })).toBe(
      authMessage({ code: "invalid_credentials" }),
    );
  });

  it("maps a disabled or unusable code to the same actionable rejection", () => {
    expect(authMessage({ code: "otp_disabled" })).toBe(
      authMessage({ code: "otp_expired" }),
    );
  });
});
