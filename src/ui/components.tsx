import React, { createContext, useContext, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  Switch,
  Platform,
  ViewStyle,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { AppState } from "../model";
import { palette, type Palette } from "./theme";
export { brand, type Palette } from "./theme";
export const light = palette;
export const dark = palette;
export const Theme = createContext<Palette>(light);
export const useTheme = () => useContext(Theme);
export const WhiteSurface = createContext(false);

function RoundedTextSurface({
  children,
  pill = false,
}: {
  children: React.ReactNode;
  pill?: boolean;
}) {
  const c = useTheme();
  const insideWhiteSurface = useContext(WhiteSurface);
  if (insideWhiteSurface) return <>{children}</>;
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderRadius: pill ? 9 : 22,
        paddingHorizontal: pill ? 9 : 12,
        paddingVertical: pill ? 5 : 8,
      }}
    >
      {children}
    </View>
  );
}
export type Change = (fn: (state: AppState) => AppState) => void;
export interface ScreenProps {
  state: AppState;
  change: Change;
  notify: (message: string) => void;
}
export function Icon({
  name,
  size = 20,
  colour,
}: {
  name: React.ComponentProps<typeof Feather>["name"];
  size?: number;
  colour?: string;
}) {
  const c = useTheme();
  return <Feather name={name} size={size} color={colour ?? c.ink} />;
}
export function Label({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  const c = useTheme();
  return (
    <RoundedTextSurface pill>
      <Text
        style={[
          {
            color: c.muted,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 1.5,
            textTransform: "uppercase",
          },
          style,
        ]}
      >
        {children}
      </Text>
    </RoundedTextSurface>
  );
}
export function Body({
  children,
  muted = false,
  style,
  pill = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
  style?: object;
  pill?: boolean;
}) {
  const c = useTheme();
  return (
    <RoundedTextSurface pill={pill}>
      <Text
        style={[
          {
            color: muted ? c.muted : c.ink,
            fontSize: 14,
            lineHeight: 22,
          },
          style,
        ]}
      >
        {children}
      </Text>
    </RoundedTextSurface>
  );
}
export function Heading({
  children,
  small = false,
}: {
  children: React.ReactNode;
  small?: boolean;
}) {
  const c = useTheme();
  return (
    <RoundedTextSurface>
      <Text
        style={{
          color: c.ink,
          fontSize: small ? 20 : 32,
          fontWeight: "600",
          letterSpacing: small ? -0.4 : -1,
          lineHeight: small ? 28 : 40,
        }}
      >
        {children}
      </Text>
    </RoundedTextSurface>
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const c = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderRadius: 22,
          borderWidth: 1,
          borderColor: c.line,
          padding: 22,
          gap: 12,
        },
        style,
        { backgroundColor: c.card },
      ]}
    >
      <WhiteSurface.Provider value={true}>{children}</WhiteSurface.Provider>
    </View>
  );
}
export function Row({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Button({
  title,
  onPress,
  icon,
  secondary = false,
  small = false,
  disabled = false,
  danger = false,
}: {
  title: string;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Feather>["name"];
  secondary?: boolean;
  small?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      accessibilityHint={danger ? "Destructive action" : undefined}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => ({
        backgroundColor: c.accent,
        borderRadius: 13,
        minHeight: small ? 44 : 48,
        paddingHorizontal: small ? 14 : 19,
        paddingVertical: 12,
        outlineColor: c.white,
        outlineWidth: focused || pressed || disabled ? 2 : secondary ? 1 : 0,
        outlineOffset: -4,
        outlineStyle: disabled ? "dashed" : "solid",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        transform: [{ translateY: pressed ? 1 : 0 }],
      })}
    >
      {!!icon && <Icon name={icon} size={17} colour={c.white} />}
      <Text
        style={{
          color: c.white,
          fontWeight: "600",
          fontSize: 13,
          textDecorationLine: focused ? "underline" : "none",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Pill({
  text,
  tone = "soft",
}: {
  text: string;
  tone?: "soft" | "sun" | "night" | "warnBg" | "redBg";
}) {
  const c = useTheme();
  return (
    <View
      style={{
        backgroundColor: c[tone],
        borderRadius: 9,
        paddingHorizontal: 9,
        paddingVertical: 5,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ fontSize: 11, color: c.ink, fontWeight: "600" }}>
        {text}
      </Text>
    </View>
  );
}
export function Field({
  label,
  value,
  onChange,
  placeholder = "",
  numeric = false,
  hint,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  numeric?: boolean;
  hint?: string;
  multiline?: boolean;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{ gap: 6, flexGrow: 1, minWidth: 140, backgroundColor: c.card }}
    >
      <Text style={{ fontSize: 13, color: c.ink, fontWeight: "600" }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        keyboardType={numeric ? "numeric" : "default"}
        multiline={multiline}
        autoCapitalize="none"
        style={{
          color: c.ink,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 12,
          paddingHorizontal: 13,
          paddingVertical: 12,
          fontSize: 15,
          minHeight: 46,
          outlineColor: c.accent,
          outlineWidth: focused ? 2 : 0,
          outlineOffset: 1,
          ...(multiline ? { minHeight: 130, textAlignVertical: "top" } : {}),
        }}
      />
      {!!hint && (
        <Text style={{ fontSize: 11, lineHeight: 17, color: c.muted }}>
          {hint}
        </Text>
      )}
    </View>
  );
}
export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        paddingVertical: 8,
      }}
    >
      <View style={{ flex: 1 }}>
        <Body style={{ fontWeight: "600" }}>{label}</Body>
        {!!hint && (
          <Body muted style={{ fontSize: 12 }}>
            {hint}
          </Body>
        )}
      </View>
      {Platform.OS === "web" ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityState={{ checked: value }}
          aria-checked={value}
          onPress={() => onChange(!value)}
          {...{
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
              // RN Web activates role="switch" with Enter; retain Space too.
              if (event.key === " ") {
                event.preventDefault();
                if (!event.repeat) onChange(!value);
              }
            },
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={({ pressed }) => ({
            width: 40,
            height: 20,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.accent,
            backgroundColor: value ? c.accent : c.white,
            outlineColor: c.accent,
            outlineWidth: focused || pressed ? 2 : 1,
            outlineOffset: 1,
            outlineStyle: value || focused ? "solid" : "dashed",
          })}
        >
          <View
            pointerEvents="none"
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: value ? c.white : c.accent,
              alignSelf: value ? "flex-end" : "flex-start",
            }}
          />
        </Pressable>
      ) : (
        <Switch
          accessibilityLabel={label}
          value={value}
          onValueChange={onChange}
          trackColor={{ false: c.white, true: c.accent }}
          thumbColor={value ? c.white : c.orange}
          ios_backgroundColor={c.white}
          style={{
            outlineColor: c.orange,
            outlineWidth: 1,
            outlineOffset: 1,
            outlineStyle: value ? "solid" : "dashed",
          }}
        />
      )}
    </View>
  );
}
export function Choices<T extends string>({
  values,
  value,
  onChange,
}: {
  values: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState<T | null>(null);
  return (
    <Row style={{ backgroundColor: c.card }}>
      {values.map((v) => (
        <Pressable
          key={v}
          accessibilityRole="button"
          accessibilityLabel={v}
          accessibilityState={{ selected: v === value }}
          aria-pressed={v === value}
          onPress={() => onChange(v)}
          onFocus={() => setFocused(v)}
          onBlur={() => setFocused(null)}
          style={({ pressed }) => ({
            backgroundColor: c.accent,
            borderRadius: 10,
            padding: 12,
            minHeight: 44,
            borderColor: c.line,
            borderWidth: 1,
            outlineColor: focused === v ? c.orange : c.white,
            outlineWidth: v === value || pressed || focused === v ? 2 : 0,
            outlineOffset: focused === v ? 2 : -4,
            transform: [{ translateY: pressed ? 1 : 0 }],
          })}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: v === value ? "800" : "600",
              color: c.white,
              textDecorationLine: v === value ? "underline" : "none",
            }}
          >
            {v}
          </Text>
        </Pressable>
      ))}
    </Row>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  const c = useTheme();
  return (
    <View
      style={{
        backgroundColor: error ? c.redBg : c.warnBg,
        padding: 15,
        borderRadius: 14,
        gap: 6,
      }}
    >
      <WhiteSurface.Provider value={true}>
        <Body style={{ color: error ? c.red : c.warn, fontSize: 13 }}>
          <Icon name={error ? "alert-circle" : "info"} size={13} /> {children}
        </Body>
      </WhiteSurface.Provider>
    </View>
  );
}
export const ui = StyleSheet.create({
  stack: { gap: 18 },
  section: { gap: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 18 },
  col: { flex: 1, minWidth: 280 },
  divider: { height: 1 },
  space: { height: 12 },
});
