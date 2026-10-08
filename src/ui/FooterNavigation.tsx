import React, { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon, useTheme } from "./components";

export interface FooterNavigationItem {
  name: string;
  icon: React.ComponentProps<typeof Icon>["name"];
}

/** The surrounding SafeAreaView owns all screen insets; this adds no second inset. */
export function FooterNavigation({
  items,
  activeTab,
  onNavigate,
}: {
  items: readonly FooterNavigationItem[];
  activeTab: string;
  onNavigate: (name: string) => void;
}) {
  const c = useTheme();
  const [availableWidth, setAvailableWidth] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{
        width: "100%",
        minWidth: 0,
        flexShrink: 0,
        alignItems: "center",
        paddingHorizontal: availableWidth <= 360 ? 8 : 16,
        paddingTop: 9,
        paddingBottom: 7,
        borderTopWidth: 1,
        borderColor: c.line,
        backgroundColor: c.card,
      }}
    >
      <View
        style={{
          width: "100%",
          maxWidth: 400,
          minWidth: 0,
          flexDirection: "row",
          gap: 10,
        }}
      >
        {items.map((item) => (
          <Pressable
            key={item.name}
            accessibilityRole="button"
            accessibilityLabel={item.name}
            accessibilityState={{ selected: activeTab === item.name }}
            aria-pressed={activeTab === item.name}
            onPress={() => onNavigate(item.name)}
            onFocus={() => setFocused(item.name)}
            onBlur={() => setFocused(null)}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 4,
              paddingVertical: 7,
              borderRadius: 11,
              backgroundColor: c.accent,
              outlineColor: focused === item.name ? c.accent : c.onAccent,
              outlineStyle: "solid",
              outlineOffset: focused === item.name ? 2 : -3,
              transform: [{ translateY: pressed ? 1 : 0 }],
              outlineWidth:
                pressed || activeTab === item.name || focused === item.name
                  ? 2
                  : 0,
            })}
          >
            <Icon name={item.icon} size={21} colour={c.onAccent} />
            <Text
              numberOfLines={1}
              style={{
                fontSize: 10,
                fontWeight: activeTab === item.name ? "700" : "600",
                color: c.onAccent,
                textDecorationLine:
                  activeTab === item.name ? "underline" : "none",
              }}
            >
              {item.name}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
