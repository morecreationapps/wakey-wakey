import React, { createContext, useContext } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  Switch,
  ViewStyle,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { AppState } from "../model";
export const light = {
  bg: "#F4F5EF",
  card: "#FFFFFF",
  ink: "#172F2B",
  muted: "#596B64",
  line: "#DFE6DE",
  accent: "#3B6555",
  soft: "#E7EEE5",
  sun: "#F3E6B9",
  warn: "#8E4C24",
  warnBg: "#FFF1DF",
  red: "#A13B3B",
  redBg: "#FCECEC",
  night: "#E6E9F3",
};
export const dark = {
  bg: "#14211E",
  card: "#1D302A",
  ink: "#EDF3E9",
  muted: "#ADBCB3",
  line: "#345045",
  accent: "#A4CEAA",
  soft: "#2B4438",
  sun: "#4A4326",
  warn: "#F3C595",
  warnBg: "#443221",
  red: "#F4ADAD",
  redBg: "#442929",
  night: "#30354C",
};
export type Palette = typeof light;
export const Theme = createContext<Palette>(light);
export const useTheme = () => useContext(Theme);
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
  );
}
export function Body({
  children,
  muted = false,
  style,
}: {
  children: React.ReactNode;
  muted?: boolean;
  style?: object;
}) {
  const c = useTheme();
  return (
    <Text
      style={[
        { color: muted ? c.muted : c.ink, fontSize: 14, lineHeight: 22 },
        style,
      ]}
    >
      {children}
    </Text>
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
      ]}
    >
      {children}
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: danger ? c.redBg : secondary ? c.soft : c.accent,
        borderRadius: 13,
        minHeight: small ? 44 : 48,
        paddingHorizontal: small ? 14 : 19,
        paddingVertical: 12,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      })}
    >
      {!!icon && (
        <Icon
          name={icon}
          size={17}
          colour={danger ? c.red : secondary ? c.ink : c.bg}
        />
      )}
      <Text
        style={{
          color: danger ? c.red : secondary ? c.ink : c.bg,
          fontWeight: "600",
          fontSize: 13,
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
  return (
    <View style={{ gap: 6, flexGrow: 1, minWidth: 140 }}>
      <Text style={{ fontSize: 13, color: c.ink, fontWeight: "600" }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        keyboardType={numeric ? "numeric" : "default"}
        multiline={multiline}
        autoCapitalize="none"
        style={{
          color: c.ink,
          backgroundColor: c.bg,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 12,
          paddingHorizontal: 13,
          paddingVertical: 12,
          fontSize: 15,
          minHeight: 46,
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
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: c.line, true: c.accent }}
      />
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
  return (
    <Row>
      {values.map((v) => (
        <Pressable
          key={v}
          accessibilityRole="button"
          accessibilityLabel={v}
          accessibilityState={{ selected: v === value }}
          onPress={() => onChange(v)}
          style={{
            backgroundColor: v === value ? c.accent : c.bg,
            borderRadius: 10,
            padding: 12,
            minHeight: 44,
            borderColor: c.line,
            borderWidth: 1,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: v === value ? c.bg : c.ink,
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
      <Body style={{ color: error ? c.red : c.warn, fontSize: 13 }}>
        {children}
      </Body>
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
