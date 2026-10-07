import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";

export type AuthScreen =
  | "login"
  | "signup"
  | "verify"
  | "forgot"
  | "recovery"
  | "reset"
  | "restoring"
  | "configuration";
export interface AuthView {
  screen: AuthScreen;
  email: string;
  busy: boolean;
  error: string;
  message: string;
  resendAt: number;
}
export interface AccountIdentity {
  id: string;
  email: string;
  expiresAt: number;
}
export interface AuthController {
  view: AuthView;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, confirmation: string): Promise<void>;
  verify(code: string): Promise<void>;
  resend(): Promise<void>;
  correctEmail(): void;
  show(screen: "login" | "signup" | "forgot"): void;
  requestRecovery(email: string): Promise<void>;
  verifyRecovery(code: string): Promise<void>;
  resetPassword(password: string, confirmation: string): Promise<void>;
}
export interface AuthProvider {
  ready: boolean;
  configurationMessage: string;
  restore(): Promise<AccountIdentity | null>;
  login(email: string, password: string): Promise<AccountIdentity>;
  signup(email: string, password: string): Promise<void>;
  verify(
    email: string,
    code: string,
    purpose: "signup" | "recovery",
  ): Promise<void>;
  resend(email: string): Promise<void>;
  recover(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  logout(): Promise<void>;
  listen(
    callback: (event: string, session: Session | null) => void,
  ): () => void;
}
const configuration =
  "Account services are not configured yet. No verification or recovery email has been sent. Your previous saved planner has been retained.";
export function authMessage(error: unknown): string {
  const e = error as { code?: string; message?: string; status?: number };
  if (e.code === "otp_expired" || e.code === "otp_disabled")
    return "This code is incorrect, expired or already used. Check the code and request a new one if needed.";
  if (e.status === 429 || e.code?.includes("rate_limit"))
    return "Too many attempts. Please wait before trying again. Email requests and verification attempts are limited by the server.";
  if (e.code === "invalid_credentials" || e.code === "user_not_found")
    return "The email or password could not be accepted. Check both, or use Forgot password.";
  if (e.code === "weak_password")
    return "Choose a stronger password with at least 12 characters.";
  if (e.code === "email_address_invalid") return "Enter a valid email address.";
  // Auth reuses unexpected_failure for mail, database and other server errors.
  // Only its known outward mail-send messages justify email-specific guidance.
  if (
    e.code === "unexpected_failure" &&
    e.status === 500 &&
    (e.message === "Error sending confirmation email" ||
      e.message === "Error sending recovery email")
  )
    return "The email service could not send a code. Please try again later or contact support. Your saved planner has been retained.";
  if (e.code === "email_address_not_authorized")
    return "The email service could not complete this request. Please try again later.";
  if (e.code === "CONFIGURATION") return configuration;
  if (e.code === "PASSWORD_SESSION_REQUIRED")
    return "Log in using your email and password to open your planner.";
  if (e.code === "NETWORK_ERROR" || e.message?.includes("fetch"))
    return "The account service could not be reached. Check your connection and try again.";
  return "The account service could not complete this request. Please try again. Your saved planner has been retained.";
}
function emailValue(email: string): string {
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error("EMAIL_VALIDATION");
  return value;
}
function newPassword(password: string, confirmation: string) {
  if (password.length < 12) throw new Error("PASSWORD_LENGTH");
  if (password !== confirmation) throw new Error("PASSWORD_MATCH");
}

/** Passwords and verification codes stay only in memory, never in persisted state. */
export class ManagedAuth implements AuthController {
  private listeners = new Set<() => void>();
  private pendingPassword: string | null = null;
  private recoveryVerified = false;
  private expectedSignOut = false;
  private generation = 0;
  private restoring: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private snapshot: { view: AuthView; identity: AccountIdentity | null };
  constructor(private provider: AuthProvider) {
    this.snapshot = {
      identity: null,
      view: {
        screen: provider.ready ? "restoring" : "configuration",
        email: "",
        busy: false,
        error: "",
        message: provider.ready
          ? ""
          : provider.configurationMessage || configuration,
        resendAt: 0,
      },
    };
  }
  get view() {
    return this.snapshot.view;
  }
  get identity() {
    return this.snapshot.identity;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(
    view: Partial<AuthView>,
    identity: AccountIdentity | null = this.identity,
  ) {
    this.snapshot = { view: { ...this.view, ...view }, identity };
    this.listeners.forEach((fn) => fn());
  }
  private identify(identity: AccountIdentity) {
    this.pendingPassword = null;
    this.recoveryVerified = false;
    clearTimeout(this.expiry);
    this.emit(
      { screen: "login", busy: false, error: "", message: "" },
      identity,
    );
    this.expiry = setTimeout(
      () => {
        void this.restore();
      },
      Math.max(0, identity.expiresAt - Date.now()),
    );
  }
  private clearIdentity(message = "", busy = false) {
    clearTimeout(this.expiry);
    this.emit({ screen: "login", busy, error: "", message }, null);
  }
  async restore() {
    if (!this.provider.ready) return;
    if (this.restoring) return this.restoring;
    const generation = this.generation;
    if (this.identity && this.identity.expiresAt <= Date.now())
      this.emit({ screen: "restoring" }, null);
    this.restoring = (async () => {
      try {
        const identity = await this.provider.restore();
        if (generation !== this.generation) return;
        if (identity) this.identify(identity);
        else this.clearIdentity();
      } catch (error) {
        if (generation !== this.generation) return;
        // A session failure always hides protected views; it never loads legacy data.
        this.clearIdentity();
        this.emit({ error: authMessage(error) });
      } finally {
        this.restoring = null;
      }
    })();
    return this.restoring;
  }
  start() {
    const unlisten = this.provider.listen((event, session) => {
      if (event === "SIGNED_OUT" && this.expectedSignOut) return;
      if (event === "SIGNED_OUT" || (event === "TOKEN_REFRESHED" && !session)) {
        ++this.generation;
        this.clearIdentity();
      } else if (
        !this.view.busy &&
        !this.recoveryVerified &&
        (event === "TOKEN_REFRESHED" || event === "SIGNED_IN")
      )
        void this.restore();
    });
    void this.restore();
    return () => {
      unlisten();
      clearTimeout(this.expiry);
      ++this.generation;
    };
  }
  show(screen: "login" | "signup" | "forgot") {
    if (this.view.busy || this.view.screen === screen) return;
    ++this.generation;
    this.pendingPassword = null;
    this.recoveryVerified = false;
    this.emit({ screen, error: "", message: "", resendAt: 0 }, null);
  }
  correctEmail() {
    this.show("signup");
    this.emit({
      message:
        "Enter the correct email address to start again. The previous unverified registration is retained and cannot access your planner.",
    });
  }
  private async run(operation: (current: () => boolean) => Promise<void>) {
    if (this.view.busy) return;
    if (!this.provider.ready) {
      this.emit({ error: configuration });
      return;
    }
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.emit({ busy: true, error: "", message: "" });
    try {
      await operation(current);
    } catch (error) {
      if (!current()) return;
      const message = (error as Error)?.message;
      this.emit({
        error:
          message === "EMAIL_VALIDATION"
            ? "Enter a valid email address."
            : message === "PASSWORD_LENGTH"
              ? "Choose a password with at least 12 characters."
              : message === "PASSWORD_MATCH"
                ? "The passwords do not match."
                : message === "PASSWORD_REQUIRED"
                  ? "Enter your password."
                  : message === "CODE_VALIDATION"
                    ? "Enter the numeric code from your email."
                    : authMessage(error),
      });
    } finally {
      if (current()) this.emit({ busy: false });
    }
  }
  login = async (email: string, password: string) =>
    this.run(async (current) => {
      const destination = emailValue(email);
      if (!password.length) throw new Error("PASSWORD_REQUIRED");
      this.emit({ email: destination });
      try {
        const identity = await this.provider.login(destination, password);
        if (current()) this.identify(identity);
      } catch (error) {
        if (!current()) return;
        if ((error as { code?: string }).code !== "email_not_confirmed")
          throw error;
        this.pendingPassword = password;
        this.emit(
          {
            screen: "verify",
            resendAt: 0,
            message:
              "Verify this email address before opening your planner. Use the confirmation code or request a new one.",
          },
          null,
        );
      }
    });
  signup = async (email: string, password: string, confirmation: string) =>
    this.run(async (current) => {
      const destination = emailValue(email);
      newPassword(password, confirmation);
      await this.provider.signup(destination, password);
      if (!current()) return;
      this.pendingPassword = password;
      this.emit(
        {
          screen: "verify",
          email: destination,
          resendAt: Date.now() + 60000,
          message:
            "A confirmation email has been requested. Check your inbox and spam folder for its code. Delivery has not been confirmed by the app.",
        },
        null,
      );
    });
  private code(code: string) {
    const value = code.replace(/\s/g, "");
    if (!/^\d{6,10}$/.test(value)) throw new Error("CODE_VALIDATION");
    return value;
  }
  verify = async (code: string) =>
    this.run(async (current) => {
      if (this.view.screen !== "verify")
        throw new Error("VERIFICATION_PURPOSE_REQUIRED");
      const password = this.pendingPassword;
      await this.provider.verify(this.view.email, this.code(code), "signup");
      // Confirmation tokens are never an alternative login method.
      if (!current()) return;
      this.expectedSignOut = true;
      try {
        await this.provider.logout();
      } finally {
        this.expectedSignOut = false;
      }
      if (!current()) return;
      if (password) {
        const identity = await this.provider.login(this.view.email, password);
        if (current()) this.identify(identity);
      } else {
        this.clearIdentity(
          "Your email is verified. Log in with your email and password.",
        );
      }
    });
  resend = async () => {
    if (Date.now() < this.view.resendAt) return;
    return this.run(async (current) => {
      if (this.view.screen === "recovery")
        await this.provider.recover(this.view.email);
      else await this.provider.resend(this.view.email);
      if (!current()) return;
      this.emit({
        resendAt: Date.now() + 60000,
        message:
          "An email has been requested. Check your inbox and spam folder. The app cannot confirm delivery.",
      });
    });
  };
  requestRecovery = async (email: string) =>
    this.run(async (current) => {
      const destination = emailValue(email);
      this.pendingPassword = null;
      await this.provider.recover(destination);
      if (!current()) return;
      this.emit(
        {
          screen: "recovery",
          email: destination,
          resendAt: Date.now() + 60000,
          message:
            "If this address can receive account recovery mail, a recovery email has been requested. Check your inbox and spam folder.",
        },
        null,
      );
    });
  verifyRecovery = async (code: string) =>
    this.run(async (current) => {
      if (this.view.screen !== "recovery") throw new Error("RECOVERY_REQUIRED");
      await this.provider.verify(this.view.email, this.code(code), "recovery");
      if (!current()) return;
      this.recoveryVerified = true;
      this.emit(
        {
          screen: "reset",
          message:
            "Choose a new password. Then log in using your email and password.",
        },
        null,
      );
    });
  resetPassword = async (password: string, confirmation: string) =>
    this.run(async (current) => {
      if (!this.recoveryVerified || this.view.screen !== "reset")
        throw new Error("RECOVERY_REQUIRED");
      newPassword(password, confirmation);
      await this.provider.updatePassword(password);
      if (!current()) return;
      this.recoveryVerified = false;
      this.expectedSignOut = true;
      try {
        await this.provider.logout();
      } finally {
        this.expectedSignOut = false;
      }
      if (!current()) return;
      this.clearIdentity(
        "Your password was changed. Log in with your email and new password.",
      );
    });
  logout = async () => {
    const generation = ++this.generation;
    this.pendingPassword = null;
    this.recoveryVerified = false;
    this.clearIdentity(
      "You are logged out. Your saved planner has been retained.",
      true,
    );
    // The provider can emit SIGNED_OUT before its asynchronous local cleanup
    // finishes. Keep login disabled until that cleanup has fully settled.
    this.expectedSignOut = true;
    try {
      await this.provider.logout();
    } catch (error) {
      if (generation === this.generation)
        this.emit({ error: authMessage(error) });
    } finally {
      this.expectedSignOut = false;
      if (generation === this.generation) this.emit({ busy: false });
    }
  };
}
export function useAuthentication(provider: AuthProvider) {
  const controller = useMemo(() => new ManagedAuth(provider), [provider]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => controller.start(), [controller]);
  return { ...snapshot, controller };
}
