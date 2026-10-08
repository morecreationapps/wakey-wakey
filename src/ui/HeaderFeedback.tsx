import React, { useState, useSyncExternalStore } from "react";
import { View, Text, Pressable } from "react-native";
import { useTheme } from "./components";
import type { HeaderFeedbackSource } from "./editFeedback";

export function HeaderFeedback({
  controller,
  onUndo,
  allowUndo = true,
}: {
  controller: HeaderFeedbackSource;
  onUndo: () => void;
  allowUndo?: boolean;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  const { status, canUndo } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!status && !(allowUndo && canUndo)) return null;
  return (
    <View style={{ alignItems: "flex-end", gap: 5, flexShrink: 0 }}>
      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            fontSize: 10,
            color: status === "Save failed" ? c.red : c.muted,
          }}
        >
          {status}
        </Text>
      ) : null}
      {allowUndo && canUndo ? (
        <Pressable
          accessibilityRole="button"
          onPress={onUndo}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={({ pressed }) => ({
            padding: 7,
            backgroundColor: c.accent,
            borderRadius: 7,
            outlineColor: c.onAccent,
            outlineWidth: pressed || focused ? 2 : 0,
            outlineStyle: "solid",
            outlineOffset: -3,
            transform: [{ translateY: pressed ? 1 : 0 }],
          })}
        >
          <Text style={{ color: c.onAccent, fontSize: 12, fontWeight: "600" }}>
            ↶ Undo recent edit
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
