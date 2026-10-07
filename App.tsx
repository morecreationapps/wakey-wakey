import React, { useEffect, useRef, useState } from "react";
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
import { initialState } from "./src/data/defaults";
import { loadState, saveState } from "./src/platform/store";
import { syncReminders } from "./src/platform/notifications";
import {
  Theme,
  light,
  dark,
  Icon,
  Button,
  Body,
  Notice,
} from "./src/ui/components";
import { Setup } from "./src/ui/Setup";
import { Today, Sleep } from "./src/ui/TodaySleep";
import { Rota } from "./src/ui/Rota";
import { Plan } from "./src/ui/Plan";
import { SettingsScreen } from "./src/ui/Settings";
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
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <View style={{ padding: 32, gap: 20 }}>
        <Text style={{ fontSize: 24 }}>This screen needs attention.</Text>
        <Text>{this.state.error}</Text>
        <Text>
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
  const [state, setState] = useState<AppState | null>(null),
    [tab, setTab] = useState("Today"),
    [message, setMessage] = useState(""),
    [saveStatus, setSaveStatus] = useState("Loading local data…"),
    [loadError, setLoadError] = useState(""),
    [, tick] = useState(0);
  const history = useRef<AppState[]>([]),
    messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
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
    setMessage(m);
    if (messageTimer.current) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(""), 8500);
  };
  const load = () =>
    loadState()
      .then((a) => {
        setState(a ?? initialState());
        setLoadError("");
      })
      .catch((e) =>
        setLoadError(
          `Local data could not be read: ${e.message}. Existing data has been retained.`,
        ),
      );
  useEffect(() => {
    load();
    const interval = setInterval(() => tick((x) => x + 1), 60000);
    return () => {
      clearInterval(interval);
      if (messageTimer.current) clearTimeout(messageTimer.current);
    };
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [state?.settings.onboardingComplete]);
  useEffect(() => {
    stateRef.current = state;
    if (!state) return;
    const revision = ++saveRevision.current;
    setSaveStatus("Saving on this device…");
    saveState(state)
      .then(() => {
        if (revision === saveRevision.current) {
          setSaveStatus("Saved on this device");
          durableState.current = state;
          syncReminders(state, systemClock).catch((e) =>
            notify(`Reminder scheduling needs attention: ${e.message}`),
          );
        }
      })
      .catch((e) => {
        if (revision === saveRevision.current) {
          setSaveStatus("Save failed");
          notify(`Your latest changes could not be saved: ${e.message}`);
        }
      });
  }, [state]);
  useEffect(() => {
    const sub = NativeAppState.addEventListener("change", (phase) => {
      if (phase === "active") {
        tick((x) => x + 1);
        if (durableState.current)
          syncReminders(durableState.current, systemClock).catch((e) =>
            notify(`Reminder refresh failed: ${e.message}`),
          );
      }
    });
    return () => sub.remove();
  }, []);
  const change = (fn: (a: AppState) => AppState) =>
    setState((a) => {
      if (!a) return a;
      const next = fn(a);
      if (
        !next.settings.onboardingComplete &&
        next.settings.onboardingStep === 0 &&
        next.entries.length === 0 &&
        next.tasks.length === 0 &&
        next.sleepLogs.length === 0
      )
        history.current = [];
      else {
        history.current.push(a);
        if (history.current.length > 12) history.current.shift();
      }
      return next;
    });
  const undo = () => {
    const previous = history.current.pop();
    if (previous) {
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
    <SafeAreaProvider>
      <Theme.Provider value={c}>
        <StatusBar style={c === dark ? "light" : "dark"} />
        <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
          <ErrorBoundary>
            {!state ? (
              <View style={{ padding: 40, gap: 18 }}>
                <Text style={{ fontSize: 28, color: c.ink, fontWeight: "600" }}>
                  Wakey-Wakey!
                </Text>
                <Body>{loadError || "Opening your local planner…"}</Body>
                {!!loadError && (
                  <Button title="Retry reading saved data" onPress={load} />
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
                    }}
                  >
                    <Image
                      source={require("./assets/wakey-wakey-icon.png")}
                      style={{ width: 44, height: 44 }}
                      resizeMode="contain"
                      accessibilityLabel="Wakey-Wakey app icon"
                    />
                    <Text
                      style={{
                        fontSize: 22,
                        fontWeight: "600",
                        letterSpacing: -0.7,
                        color: c.ink,
                      }}
                    >
                      Wakey-Wakey!
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 5 }}>
                    <Text
                      style={{
                        fontSize: 10,
                        color: saveStatus === "Save failed" ? c.red : c.muted,
                      }}
                    >
                      {saveStatus}
                    </Text>
                    {state.settings.onboardingComplete && (
                      <Pressable
                        accessibilityRole="button"
                        onPress={undo}
                        style={{ padding: 7 }}
                      >
                        <Text
                          style={{
                            color: c.accent,
                            fontSize: 12,
                            fontWeight: "600",
                          }}
                        >
                          ↶ Undo recent edit
                        </Text>
                      </Pressable>
                    )}
                  </View>
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
                      }}
                    >
                      {tabs.map((t) => (
                        <Pressable
                          key={t.name}
                          accessibilityRole="button"
                          accessibilityLabel={t.name}
                          accessibilityState={{ selected: tab === t.name }}
                          onPress={() => navigate(t.name)}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 13,
                            padding: 16,
                            borderRadius: 13,
                            backgroundColor:
                              tab === t.name ? c.soft : undefined,
                          }}
                        >
                          <Icon
                            name={t.icon}
                            size={20}
                            colour={tab === t.name ? c.accent : c.muted}
                          />
                          <Text
                            style={{
                              fontSize: 14,
                              fontWeight: tab === t.name ? "700" : "500",
                              color: c.ink,
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
                        Your time, thoughtfully planned.{"\n"}Local by default.
                      </Text>
                    </View>
                  )}
                  <ScrollView
                    ref={scroll}
                    style={{ flex: 1 }}
                    contentContainerStyle={{
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
                        <SettingsScreen {...props!} />
                      )}
                    </View>
                  </ScrollView>
                </View>
                {!wide && state.settings.onboardingComplete && (
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-around",
                      paddingTop: 9,
                      paddingBottom: 7,
                      borderTopWidth: 1,
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
                        onPress={() => navigate(t.name)}
                        style={{
                          alignItems: "center",
                          gap: 5,
                          minWidth: 54,
                          padding: 7,
                          borderRadius: 11,
                          backgroundColor: tab === t.name ? c.soft : undefined,
                        }}
                      >
                        <Icon
                          name={t.icon}
                          size={21}
                          colour={tab === t.name ? c.accent : c.muted}
                        />
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: "600",
                            color: tab === t.name ? c.accent : c.muted,
                          }}
                        >
                          {t.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
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
                      backgroundColor: c.ink,
                      borderRadius: 16,
                      padding: 18,
                      shadowOpacity: 0.2,
                      shadowRadius: 12,
                    }}
                  >
                    <Text style={{ color: c.bg, fontSize: 13, lineHeight: 20 }}>
                      {message}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </ErrorBoundary>
        </SafeAreaView>
      </Theme.Provider>
    </SafeAreaProvider>
  );
}
