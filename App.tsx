import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  useColorScheme,
  useWindowDimensions,
  AppState as NativeAppState,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppState, systemClock } from "./src/model";
import { startPlannerClock } from "./src/engine/plannerClock";
import { initialState } from "./src/data/defaults";
import {
  createAccountStore,
  handleAccountAccessDenied,
  type AccountConflictReview,
  type AccountConflictRecovery,
  type AccountStore,
} from "./src/auth/accountStore";
import { authProvider, accountRemote, hashSnapshot } from "./src/auth/service";
import { useAuthentication, type AccountIdentity } from "./src/auth/controller";
import { accountCache } from "./src/platform/accountCache";
import { readLegacySnapshot } from "./src/platform/legacySnapshot";
import {
  activateNotificationOwner,
  clearNotificationOwner,
} from "./src/platform/notificationScope";
import { AuthScreens } from "./src/ui/AuthScreens";
import { AccountConflict } from "./src/ui/AccountConflict";
import { exportTextFile } from "./src/platform/files";
import { syncReminders, disableReminders } from "./src/platform/notifications";
import {
  Theme,
  light,
  dark,
  Icon,
  Button,
  Body,
  Notice,
  WhiteSurface,
} from "./src/ui/components";
import { Setup } from "./src/ui/Setup";
import { Today, Sleep } from "./src/ui/TodaySleep";
import { Rota } from "./src/ui/Rota";
import { Plan } from "./src/ui/Plan";
import { SettingsScreen } from "./src/ui/Settings";
import { createHeaderFeedback } from "./src/ui/editFeedback";
import { HeaderFeedback } from "./src/ui/HeaderFeedback";
import { FooterNavigation } from "./src/ui/FooterNavigation";
const tabs = [
  { name: "Today", icon: "sun" },
  { name: "Rota", icon: "calendar" },
  { name: "Plan", icon: "check-square" },
  { name: "Sleep", icon: "moon" },
  { name: "Settings", icon: "sliders" },
] as const;
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  static contextType = Theme;
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    const c = this.context as React.ContextType<typeof Theme>;
    return this.state.error ? (
      <View style={{ padding: 32, gap: 20, backgroundColor: c.card }}>
        <Text style={{ fontSize: 24, color: c.ink }}>
          <Icon name="alert-triangle" size={24} colour={c.ink} /> This screen
          needs attention.
        </Text>
        <Text style={{ color: c.ink }}>{this.state.error}</Text>
        <Text style={{ color: c.ink }}>
          Your saved information has not been deliberately deleted. Restart the
          app after correcting the issue.
        </Text>
      </View>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  const { identity, controller } = useAuthentication(authProvider);
  const store = useMemo(
    () =>
      identity
        ? createAccountStore({
            userId: identity.id,
            remote: accountRemote(identity.id),
            cache: accountCache,
            readLegacy: readLegacySnapshot,
            hash: hashSnapshot,
          })
        : null,
    [identity?.id],
  );
  useEffect(() => {
    if (!identity) return;
    activateNotificationOwner(identity.id);
    return () => {
      clearNotificationOwner(identity.id);
      void disableReminders().catch(() => undefined);
    };
  }, [identity?.id]);
  const logout = async () => {
    clearNotificationOwner();
    const cancelling = disableReminders();
    await controller.logout();
    await cancelling.catch(() => undefined);
  };
  return (
    <SafeAreaProvider>
      <Theme.Provider value={light}>
        <StatusBar style="dark" />
        <SafeAreaView
          edges={["top", "right", "bottom", "left"]}
          style={{ flex: 1, backgroundColor: light.bg }}
        >
          {identity && store ? (
            <Planner
              key={identity.id}
              identity={identity}
              store={store}
              logout={logout}
            />
          ) : (
            <AuthScreens controller={controller} />
          )}
        </SafeAreaView>
      </Theme.Provider>
    </SafeAreaProvider>
  );
}
function Planner({
  identity,
  store,
  logout,
}: {
  identity: AccountIdentity;
  store: AccountStore;
  logout: () => Promise<void>;
}) {
  const active = useRef(true);
  const plannerClock = useRef<ReturnType<typeof startPlannerClock> | null>(
    null,
  );
  const [focusedControl, setFocusedControl] = useState("");
  const [conflict, setConflict] = useState<AccountConflictReview | null>(null);
  const [recovery, setRecovery] = useState<AccountConflictRecovery | null>(
    null,
  );
  const [loadingAccount, setLoadingAccount] = useState(false);
  const loadingAccountRef = useRef(false);
  const [state, setState] = useState<AppState | null>(null),
    [tab, setTab] = useState("Today"),
    [message, setMessage] = useState(""),
    [loadError, setLoadError] = useState(""),
    [, tick] = useState(0);
  const feedback = useMemo(
    () =>
      createHeaderFeedback<AppState>({
        initialStatus: "Loading account data…",
      }),
    [],
  );
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    scroll = useRef<ScrollView>(null),
    stateRef = useRef<AppState | null>(null),
    saveRevision = useRef(0),
    durableState = useRef<AppState | null>(null);
  const scheme = useColorScheme(),
    { width } = useWindowDimensions(),
    wide = width >= 940;
  const c =
    state?.settings.theme === "dark" ||
    (state?.settings.theme === "system" && scheme === "dark")
      ? dark
      : light;
  const notify = (m: string) => {
    if (!active.current) return;
    setMessage(m);
    if (messageTimer.current) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(""), 8500);
  };
  const deactivate = () => {
    active.current = false;
    ++saveRevision.current;
    stateRef.current = null;
    durableState.current = null;
    feedback.deactivate();
    if (messageTimer.current) clearTimeout(messageTimer.current);
    clearNotificationOwner(identity.id);
  };
  const leaveAccount = async () => {
    deactivate();
    await logout();
  };
  const accessDenied = (error: unknown) =>
    handleAccountAccessDenied(error, { deactivate, logout });
  const accountOperation = async <T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (active.current) accessDenied(error);
      throw error;
    }
  };
  const openLoadedState = (a: AppState) => {
    if (!active.current) return;
    stateRef.current = a;
    durableState.current = a;
    ++saveRevision.current;
    // Undo history belongs to the copy that was edited, not a newly opened or
    // recovered account snapshot.
    // A read is already durable. Opening a planner must not create a new cloud
    // revision or turn another browser's pending edits into a conflict.
    feedback.opened({ offline: store.status().offline });
    setState(a);
    setLoadError("");
    setConflict(null);
    void store
      .readConflictRecovery()
      .then((saved) => {
        if (active.current) setRecovery(saved);
      })
      .catch((e) => {
        if (active.current && !accessDenied(e))
          notify(`Preserved backup access needs attention: ${e.message}`);
      });
    syncReminders(a, systemClock, identity.id).catch((e) =>
      notify(`Reminder scheduling needs attention: ${e.message}`),
    );
  };
  const reviewConflict = async () => {
    const review = await store.reviewConflict();
    if (!active.current) return;
    setConflict(review);
    setLoadError("");
  };
  const load = async () => {
    if (loadingAccountRef.current) return;
    loadingAccountRef.current = true;
    setLoadingAccount(true);
    setLoadError("");
    try {
      openLoadedState(await store.loadState());
    } catch (e) {
      if (!active.current || accessDenied(e)) return;
      if ((e as { code?: string }).code === "CONFLICT") {
        try {
          await reviewConflict();
          return;
        } catch (reviewError) {
          if (!active.current || accessDenied(reviewError)) return;
          e = reviewError;
        }
      }
      setLoadError(
        `Account data could not be read: ${(e as Error).message} Existing data has been retained.`,
      );
    } finally {
      loadingAccountRef.current = false;
      if (active.current) setLoadingAccount(false);
    }
  };
  const openAccountVersion = async () => {
    if (!conflict || loadingAccountRef.current) return;
    loadingAccountRef.current = true;
    setLoadingAccount(true);
    setLoadError("");
    try {
      openLoadedState(await store.resolveConflictWithAccount(conflict));
    } catch (e) {
      if (!active.current || accessDenied(e)) return;
      setLoadError((e as Error).message);
    } finally {
      loadingAccountRef.current = false;
      if (active.current) setLoadingAccount(false);
    }
  };
  const downloadConflict = async (source: "device" | "account") => {
    if (!conflict) return;
    try {
      await exportTextFile(
        `wakey-wakey-${source}-revision-${conflict[source].summary.revision}.json`,
        conflict[source].payload,
        "application/json",
      );
      notify(
        `${source === "device" ? "Device" : "Account"} backup download requested.`,
      );
    } catch (e) {
      if (active.current)
        setLoadError(`Backup export failed: ${(e as Error).message}`);
    }
  };
  const downloadRecovery = async (source: "device" | "account") => {
    try {
      // Re-read and validate the immutable recovery copy when exporting it.
      const saved = await store.readConflictRecovery();
      if (!saved || !active.current) return;
      await exportTextFile(
        `wakey-wakey-preserved-${source}-revision-${saved[source].summary.revision}.json`,
        saved[source].payload,
        "application/json",
      );
      notify(`Preserved ${source} backup download requested.`);
    } catch (e) {
      if (active.current && !accessDenied(e))
        notify(`Preserved backup export failed: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    active.current = true;
    feedback.activate();
    load();
    const clock = startPlannerClock(() => tick((x) => x + 1));
    plannerClock.current = clock;
    const refresh = () => {
      if (typeof document === "undefined" || !document.hidden) clock.refresh();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", refresh);
    if (typeof window !== "undefined")
      window.addEventListener("focus", refresh);
    return () => {
      deactivate();
      clock.stop();
      plannerClock.current = null;
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", refresh);
      if (typeof window !== "undefined")
        window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [state?.settings.onboardingComplete]);
  useEffect(() => {
    if (!state || !active.current || state === durableState.current) return;
    const revision = ++saveRevision.current;
    const ticket = feedback.beginSave();
    store
      .saveState(state)
      .then(() => {
        if (
          active.current &&
          revision === saveRevision.current &&
          feedback.saved(ticket, { offline: store.status().offline })
        ) {
          durableState.current = state;
          syncReminders(state, systemClock, identity.id).catch((e) =>
            notify(`Reminder scheduling needs attention: ${e.message}`),
          );
        }
      })
      .catch((e) => {
        if (!active.current || accessDenied(e)) return;
        if (
          active.current &&
          revision === saveRevision.current &&
          feedback.failed(ticket)
        ) {
          notify(`Your latest changes could not be saved: ${e.message}`);
          if (e.code === "CONFLICT") {
            stateRef.current = null;
            durableState.current = null;
            setState(null);
            void load();
          }
        }
      });
  }, [state]);
  useEffect(() => {
    const sub = NativeAppState.addEventListener("change", (phase) => {
      if (phase === "active") {
        plannerClock.current?.refresh();
        if (durableState.current)
          syncReminders(durableState.current, systemClock, identity.id).catch(
            (e) => notify(`Reminder refresh failed: ${e.message}`),
          );
      }
    });
    return () => sub.remove();
  }, []);
  const change = (fn: (a: AppState) => AppState) => {
    const a = stateRef.current;
    if (!a || !active.current) return;
    const next = fn(a);
    const reset =
      !next.settings.onboardingComplete &&
      next.settings.onboardingStep === 0 &&
      next.entries.length === 0 &&
      next.tasks.length === 0 &&
      next.sleepLogs.length === 0;
    if (!feedback.edit(a, next, !reset)) return;
    stateRef.current = next;
    setState(next);
  };
  const undo = () => {
    const previous = feedback.undo();
    if (previous) {
      stateRef.current = previous;
      setState(previous);
      notify(
        "Recent change undone. Plans and reminders refresh from the restored data.",
      );
    } else notify("There is no recent edit to undo.");
  };
  const navigate = (name: string) => {
    setTab(name);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const props = state ? { state, change, notify } : null;
  return (
    <Theme.Provider value={c}>
      <StatusBar style="dark" />
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ErrorBoundary>
          {!state && conflict ? (
            <AccountConflict
              review={conflict}
              busy={loadingAccount}
              error={loadError}
              message={message}
              onRefresh={() => void load()}
              onDownload={(source) => void downloadConflict(source)}
              onOpenAccount={() => void openAccountVersion()}
              onLogout={() => void leaveAccount()}
            />
          ) : !state ? (
            <View style={{ padding: 40, gap: 18, backgroundColor: c.card }}>
              <Text style={{ fontSize: 28, color: c.ink, fontWeight: "600" }}>
                Wakey-Wakey!
              </Text>
              <WhiteSurface.Provider value={true}>
                <Body>{loadError || "Opening your account planner…"}</Body>
              </WhiteSurface.Provider>
              {!!loadError && (
                <>
                  <Button
                    title="Retry reading saved data"
                    disabled={loadingAccount}
                    onPress={() => void load()}
                  />
                  <Button
                    title="Log out"
                    secondary
                    onPress={() => void leaveAccount()}
                  />
                </>
              )}
            </View>
          ) : (
            <>
              <View
                style={{
                  height: 76,
                  paddingHorizontal: wide ? 36 : 20,
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  borderBottomWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.card,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 11,
                    flexShrink: 1,
                    minWidth: 0,
                  }}
                >
                  <Image
                    source={require("./assets/wakey-wakey-icon.png")}
                    style={{ width: 44, height: 44, flexShrink: 0 }}
                    resizeMode="contain"
                    accessible={false}
                  />
                  <Image
                    source={require("./assets/wakey-wakey-wordmark.png")}
                    style={{
                      width: 168,
                      height: 40,
                      flexShrink: 1,
                      minWidth: 0,
                    }}
                    resizeMode="contain"
                    accessibilityLabel="Wakey-Wakey!"
                  />
                </View>
                <HeaderFeedback
                  controller={feedback}
                  onUndo={undo}
                  allowUndo={state.settings.onboardingComplete}
                />
              </View>
              <View style={{ flex: 1, flexDirection: "row" }}>
                {wide && state.settings.onboardingComplete && (
                  <View
                    style={{
                      width: 200,
                      padding: 22,
                      gap: 9,
                      borderRightWidth: 1,
                      borderColor: c.line,
                      backgroundColor: c.card,
                    }}
                  >
                    {tabs.map((t) => (
                      <Pressable
                        key={t.name}
                        accessibilityRole="button"
                        accessibilityLabel={t.name}
                        accessibilityState={{ selected: tab === t.name }}
                        aria-pressed={tab === t.name}
                        onPress={() => navigate(t.name)}
                        onFocus={() => setFocusedControl(`side-${t.name}`)}
                        onBlur={() => setFocusedControl("")}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 13,
                          padding: 16,
                          borderRadius: 13,
                          backgroundColor: c.accent,
                          outlineColor:
                            focusedControl === `side-${t.name}`
                              ? c.accent
                              : c.onAccent,
                          outlineStyle: "solid",
                          outlineOffset:
                            focusedControl === `side-${t.name}` ? 2 : -4,
                          transform: [{ translateY: pressed ? 1 : 0 }],
                          outlineWidth:
                            pressed ||
                            tab === t.name ||
                            focusedControl === `side-${t.name}`
                              ? 2
                              : 0,
                        })}
                      >
                        <Icon name={t.icon} size={20} colour={c.onAccent} />
                        <Text
                          style={{
                            fontSize: 14,
                            fontWeight: tab === t.name ? "700" : "500",
                            color: c.onAccent,
                            textDecorationLine:
                              tab === t.name ? "underline" : "none",
                          }}
                        >
                          {t.name}
                        </Text>
                      </Pressable>
                    ))}
                    <View style={{ flex: 1 }} />
                    <Text
                      style={{ fontSize: 11, color: c.muted, lineHeight: 18 }}
                    >
                      Your time, thoughtfully planned.{"\n"}Your own account.
                    </Text>
                  </View>
                )}
                <ScrollView
                  ref={scroll}
                  style={{ flex: 1, backgroundColor: c.bg }}
                  contentContainerStyle={{
                    backgroundColor: c.bg,
                    padding: wide ? 32 : 18,
                    paddingBottom: 40,
                  }}
                  keyboardShouldPersistTaps="handled"
                >
                  <View
                    style={{
                      maxWidth: 1150,
                      width: "100%",
                      alignSelf: "center",
                    }}
                  >
                    {!state.settings.onboardingComplete ? (
                      <Setup {...props!} />
                    ) : tab === "Today" ? (
                      <Today {...props!} navigate={navigate} />
                    ) : tab === "Rota" ? (
                      <Rota {...props!} />
                    ) : tab === "Plan" ? (
                      <Plan {...props!} />
                    ) : tab === "Sleep" ? (
                      <Sleep {...props!} />
                    ) : (
                      <SettingsScreen
                        {...props!}
                        saveAccount={(a) =>
                          accountOperation(() => store.saveState(a))
                        }
                        resetAccount={() =>
                          accountOperation(() => store.deleteState())
                        }
                        accountEmail={identity.email}
                        accountId={identity.id}
                        logout={leaveAccount}
                        recovery={recovery}
                        exportRecovery={(source) =>
                          void downloadRecovery(source)
                        }
                      />
                    )}
                  </View>
                </ScrollView>
              </View>
              {!wide && state.settings.onboardingComplete && (
                <FooterNavigation
                  items={tabs}
                  activeTab={tab}
                  onNavigate={navigate}
                />
              )}
              {!!message && (
                <Pressable
                  accessibilityRole="alert"
                  onPress={() => setMessage("")}
                  style={{
                    position: "absolute",
                    left: wide ? 240 : 16,
                    right: 16,
                    bottom:
                      state.settings.onboardingComplete && !wide ? 85 : 20,
                    backgroundColor: c.card,
                    borderRadius: 16,
                    padding: 18,
                    borderWidth: 1,
                    borderColor: c.accent,
                  }}
                >
                  <Text style={{ color: c.ink, fontSize: 13, lineHeight: 20 }}>
                    {message}
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </ErrorBoundary>
      </View>
    </Theme.Provider>
  );
}
