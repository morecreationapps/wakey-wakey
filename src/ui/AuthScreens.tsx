import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import type { AuthController } from "../auth/controller";
import { Body, Button, Card, Heading, Notice, useTheme } from "./components";

type InputKind = "email" | "current-password" | "new-password" | "code";

function AuthField({
  label,
  value,
  onChange,
  kind,
  disabled,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: InputKind;
  disabled: boolean;
  onSubmit?: () => void;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const password = kind === "current-password" || kind === "new-password";
  const email = kind === "email";
  useEffect(() => setVisible(false), [kind]);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.ink }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        secureTextEntry={password && !visible}
        keyboardType={
          email ? "email-address" : kind === "code" ? "number-pad" : "default"
        }
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete={
          email
            ? "email"
            : kind === "code"
              ? "one-time-code"
              : kind === "new-password"
                ? "new-password"
                : "current-password"
        }
        textContentType={
          email
            ? "emailAddress"
            : kind === "code"
              ? "oneTimeCode"
              : kind === "new-password"
                ? "newPassword"
                : "password"
        }
        importantForAutofill="yes"
        returnKeyType={onSubmit ? "go" : "next"}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          backgroundColor: c.card,
          color: c.ink,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 12,
          minHeight: 48,
          paddingHorizontal: 13,
          paddingVertical: 12,
          fontSize: 16,
          outlineColor: c.accent,
          outlineWidth: focused ? 2 : 0,
          outlineOffset: 1,
          ...(kind === "code" ? { letterSpacing: 3 } : {}),
        }}
      />
      {password && (
        <View style={{ alignSelf: "flex-end" }}>
          <Button
            title={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
            icon={visible ? "eye-off" : "eye"}
            small
            secondary
            disabled={disabled}
            onPress={() => setVisible((previous) => !previous)}
          />
        </View>
      )}
    </View>
  );
}

const titles = {
  login: "Log in",
  signup: "Create account",
  verify: "Verify your email",
  forgot: "Forgot password?",
  recovery: "Check your recovery email",
  reset: "Set a new password",
  restoring: "Restoring your session",
  configuration: "Sign-in unavailable",
} as const;

export function AuthScreens({ controller }: { controller: AuthController }) {
  const c = useTheme();
  const { width } = useWindowDimensions();
  const { view } = controller;
  const [email, setEmail] = useState(view.email);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [validation, setValidation] = useState("");
  const [pending, setPending] = useState(false);
  const [focusedTab, setFocusedTab] = useState("");
  const [now, setNow] = useState(Date.now());
  const submitting = useRef(false);
  const busy = view.busy || pending;
  const resendSeconds = Math.max(0, Math.ceil((view.resendAt - now) / 1000));
  const wordmarkWidth = Math.min(280, Math.max(150, width - 132));

  useEffect(() => {
    setPassword("");
    setConfirmation("");
    setCode("");
    setValidation("");
  }, [view.screen]);
  useEffect(() => setEmail(view.email), [view.email]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setValidation("");
  };
  const validEmail = () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidation("Enter a valid email address.");
      return false;
    }
    return true;
  };
  const validPassword = (confirm = false) => {
    if (!password) {
      setValidation("Enter your password.");
      return false;
    }
    if (confirm && password.length < 12) {
      setValidation("Use a password with at least 12 characters.");
      return false;
    }
    if (confirm && password !== confirmation) {
      setValidation(
        "The passwords do not match. Re-enter the same password in both fields.",
      );
      return false;
    }
    return true;
  };
  const validCode = () => {
    if (!/^\d{6,10}$/.test(code.replace(/\s/g, ""))) {
      setValidation(
        "Enter the 6–10 digit code from your email. You can paste it here.",
      );
      return false;
    }
    return true;
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busy || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setValidation("");
    try {
      await operation();
    } catch {
      setValidation(
        "The request could not be completed. Check your connection and try again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
      setNow(Date.now());
    }
  };
  const submit = () => {
    if (busy) return;
    switch (view.screen) {
      case "login":
        if (validEmail() && validPassword())
          void perform(() => controller.login(email, password));
        break;
      case "signup":
        if (validEmail() && validPassword(true))
          void perform(() => controller.signup(email, password, confirmation));
        break;
      case "verify":
        if (validCode())
          void perform(() => controller.verify(code.replace(/\s/g, "")));
        break;
      case "forgot":
        if (validEmail()) void perform(() => controller.requestRecovery(email));
        break;
      case "recovery":
        if (validCode())
          void perform(() =>
            controller.verifyRecovery(code.replace(/\s/g, "")),
          );
        break;
      case "reset":
        if (validPassword(true))
          void perform(() => controller.resetPassword(password, confirmation));
        break;
    }
  };
  const emailField = (
    <AuthField
      label="Email address"
      value={email}
      onChange={change(setEmail)}
      kind="email"
      disabled={busy}
      onSubmit={view.screen === "forgot" ? submit : undefined}
    />
  );
  const passwordFields = (confirm: boolean) => (
    <>
      <AuthField
        label={view.screen === "reset" ? "New password" : "Password"}
        value={password}
        onChange={change(setPassword)}
        kind={confirm ? "new-password" : "current-password"}
        disabled={busy}
        onSubmit={confirm ? undefined : submit}
      />
      {confirm && (
        <>
          <Body style={{ fontSize: 12, lineHeight: 18 }}>
            Use at least 12 characters. Spaces and pasted passwords are
            preserved exactly.
          </Body>
          <AuthField
            label="Confirm password"
            value={confirmation}
            onChange={change(setConfirmation)}
            kind="new-password"
            disabled={busy}
            onSubmit={submit}
          />
        </>
      )}
    </>
  );
  const error = validation || view.error;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={
        Platform.OS === "ios"
          ? "padding"
          : Platform.OS === "android"
            ? "height"
            : undefined
      }
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 28 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View
          style={{
            backgroundColor: c.card,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
            paddingHorizontal: 18,
            paddingVertical: 20,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 480,
              alignSelf: "center",
              flexDirection: "row",
              justifyContent: "center",
              alignItems: "center",
              gap: 14,
            }}
          >
            <Image
              source={require("../../assets/wakey-wakey-icon.png")}
              style={{ width: 64, height: 64, flexShrink: 0 }}
              resizeMode="contain"
              accessible={false}
            />
            <Image
              source={require("../../assets/wakey-wakey-wordmark.png")}
              style={{
                width: wordmarkWidth,
                height: 68,
                flexShrink: 1,
                minWidth: 0,
              }}
              resizeMode="contain"
              accessibilityLabel="Wakey-Wakey!"
            />
          </View>
        </View>
        <View
          style={{
            width: "100%",
            maxWidth: 512,
            alignSelf: "center",
            padding: 16,
            gap: 16,
          }}
        >
          <Card style={{ gap: 18, padding: width < 360 ? 18 : 22 }}>
            {(view.screen === "login" || view.screen === "signup") && (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 10,
                  backgroundColor: c.card,
                }}
              >
                {(
                  [
                    { screen: "login", label: "Log in" },
                    { screen: "signup", label: "Create account" },
                  ] as const
                ).map((mode) => (
                  <Pressable
                    key={mode.screen}
                    accessibilityRole="tab"
                    role="tab"
                    accessibilityLabel={`${mode.label} screen`}
                    aria-selected={view.screen === mode.screen}
                    aria-disabled={busy}
                    accessibilityState={{
                      selected: view.screen === mode.screen,
                      disabled: busy,
                    }}
                    disabled={busy}
                    onPress={() => {
                      if (view.screen !== mode.screen)
                        controller.show(mode.screen);
                    }}
                    onFocus={() => setFocusedTab(mode.screen)}
                    onBlur={() => setFocusedTab("")}
                    style={({ pressed }) => ({
                      backgroundColor: c.accent,
                      borderRadius: 10,
                      padding: 12,
                      minHeight: 44,
                      borderColor: c.line,
                      borderWidth: 1,
                      outlineColor:
                        focusedTab === mode.screen ? c.orange : c.white,
                      outlineWidth:
                        view.screen === mode.screen ||
                        pressed ||
                        focusedTab === mode.screen ||
                        busy
                          ? 2
                          : 0,
                      outlineOffset: focusedTab === mode.screen ? 2 : -4,
                      outlineStyle: busy ? "dashed" : "solid",
                      transform: [{ translateY: pressed ? 1 : 0 }],
                    })}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: view.screen === mode.screen ? "800" : "600",
                        color: c.white,
                        textDecorationLine:
                          view.screen === mode.screen ? "underline" : "none",
                      }}
                    >
                      {mode.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View
              role="heading"
              accessibilityRole="header"
              {...(Platform.OS === "web" ? { "aria-level": 1 } : {})}
            >
              <Heading>{titles[view.screen]}</Heading>
            </View>
            {view.screen === "login" && (
              <Body>
                Use your email address and password to open your own saved
                plans.
              </Body>
            )}
            {view.screen === "signup" && (
              <Body>
                Create your account with an email address and password. You will
                then confirm your email with a code.
              </Body>
            )}
            {view.screen === "forgot" && (
              <Body>
                Request a recovery code by email, then set a new password. You
                will log in with your email and password afterwards.
              </Body>
            )}
            {(view.screen === "verify" || view.screen === "recovery") && (
              <>
                <Body>
                  {view.screen === "verify"
                    ? "Enter the confirmation code for:"
                    : "Enter the recovery code for:"}
                </Body>
                <Body style={{ fontWeight: "700" }}>{view.email}</Body>
                <Body>
                  Check your inbox and junk folder. Use the latest code; codes
                  expire and can only be used once.
                </Body>
              </>
            )}
            {view.screen === "reset" && (
              <Body>
                Choose a new password for your account. Once it is saved, log in
                normally with your email and password.
              </Body>
            )}
            {!!error && (
              <View
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <Notice error>{error}</Notice>
              </View>
            )}
            {!!view.message && (
              <View accessibilityLiveRegion="polite">
                <Notice>{view.message}</Notice>
              </View>
            )}
            {(view.screen === "login" ||
              view.screen === "signup" ||
              view.screen === "forgot") &&
              emailField}
            {view.screen === "login" && passwordFields(false)}
            {(view.screen === "signup" || view.screen === "reset") &&
              passwordFields(true)}
            {(view.screen === "verify" || view.screen === "recovery") && (
              <AuthField
                label={
                  view.screen === "verify"
                    ? "Email confirmation code"
                    : "Password recovery code"
                }
                value={code}
                onChange={change(setCode)}
                kind="code"
                disabled={busy}
                onSubmit={submit}
              />
            )}
            {busy && view.screen !== "restoring" && (
              <View
                accessibilityLiveRegion="polite"
                style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
              >
                <ActivityIndicator
                  color={c.accent}
                  accessibilityLabel="Request in progress"
                />
                <Body>Working… Please wait.</Body>
              </View>
            )}
            {view.screen === "login" && (
              <>
                <Button
                  title={busy ? "Logging in…" : "Log in"}
                  onPress={submit}
                  disabled={busy}
                  icon="log-in"
                />
                <Button
                  title="Forgot password?"
                  secondary
                  onPress={() => controller.show("forgot")}
                  disabled={busy}
                />
                <Button
                  title="Create account"
                  secondary
                  onPress={() => controller.show("signup")}
                  disabled={busy}
                />
              </>
            )}
            {view.screen === "signup" && (
              <>
                <Button
                  title={busy ? "Creating account…" : "Create my account"}
                  onPress={submit}
                  disabled={busy}
                  icon="user-plus"
                />
                <Button
                  title="Back to log in"
                  secondary
                  onPress={() => controller.show("login")}
                  disabled={busy}
                />
              </>
            )}
            {view.screen === "verify" && (
              <>
                <Button
                  title={busy ? "Verifying…" : "Verify email"}
                  onPress={submit}
                  disabled={busy}
                  icon="check-circle"
                />
                <Button
                  title={
                    resendSeconds > 0
                      ? `Resend code in ${resendSeconds}s`
                      : "Resend code"
                  }
                  secondary
                  disabled={busy || resendSeconds > 0}
                  onPress={() => {
                    if (Date.now() >= view.resendAt)
                      void perform(() => controller.resend());
                  }}
                />
                <Body>
                  A resend requests another email; delivery may take a few
                  minutes.
                </Body>
                <Button
                  title="Correct email address"
                  secondary
                  disabled={busy}
                  onPress={() => controller.correctEmail()}
                />
                <Body>
                  Correcting the address returns to account creation. Your
                  previous unverified registration is not overwritten.
                </Body>
                <Button
                  title="Back to log in"
                  secondary
                  disabled={busy}
                  onPress={() => controller.show("login")}
                />
              </>
            )}
            {view.screen === "forgot" && (
              <>
                <Button
                  title={
                    busy ? "Requesting recovery…" : "Request recovery code"
                  }
                  onPress={submit}
                  disabled={busy}
                  icon="mail"
                />
                <Button
                  title="Back to log in"
                  secondary
                  disabled={busy}
                  onPress={() => controller.show("login")}
                />
              </>
            )}
            {view.screen === "recovery" && (
              <>
                <Button
                  title={busy ? "Checking code…" : "Verify recovery code"}
                  onPress={submit}
                  disabled={busy}
                  icon="check-circle"
                />
                <Button
                  title={
                    resendSeconds > 0
                      ? `Resend recovery code in ${resendSeconds}s`
                      : "Resend recovery code"
                  }
                  secondary
                  disabled={busy || resendSeconds > 0}
                  onPress={() => {
                    if (Date.now() >= view.resendAt)
                      void perform(() => controller.resend());
                  }}
                />
                <Button
                  title="Use another email address"
                  secondary
                  disabled={busy}
                  onPress={() => controller.show("forgot")}
                />
                <Button
                  title="Back to log in"
                  secondary
                  disabled={busy}
                  onPress={() => controller.show("login")}
                />
              </>
            )}
            {view.screen === "reset" && (
              <Button
                title={busy ? "Saving password…" : "Save new password"}
                disabled={busy}
                onPress={submit}
                icon="lock"
              />
            )}
            {view.screen === "restoring" && (
              <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
                <ActivityIndicator
                  color={c.accent}
                  size="large"
                  accessibilityLabel="Restoring session"
                />
                <Body>
                  Checking your session before opening your saved information.
                </Body>
              </View>
            )}
            {view.screen === "configuration" && (
              <Body>
                Secure sign-in is unavailable until the authentication and
                email-service configuration is completed. Your saved information
                has been retained.
              </Body>
            )}
          </Card>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
