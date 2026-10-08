import React, { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Temporal } from "@js-temporal/polyfill";
import { weekdayLabels } from "../engine/calendar";
import { dateInZone, displayDate, localAt } from "../engine/time";
import { systemClock, type Settings } from "../model";
import { Icon, useTheme } from "./components";
import {
  calendarMonthDays,
  formatPickerDateTime,
  formatPickerTime,
  fromClockParts,
  replacePickerDate,
  replacePickerTime,
  shiftCalendarMonth,
  toClockParts,
} from "./pickerValues";

type PickerSettings = Pick<
  Settings,
  "dateFormat" | "clockFormat" | "firstDay" | "timezone"
>;

function Choice({
  label,
  accessibilityLabel,
  children,
  selected = false,
  filled = false,
  onPress,
  style,
}: {
  label: string;
  accessibilityLabel?: string;
  children?: React.ReactNode;
  selected?: boolean;
  filled?: boolean;
  onPress: () => void;
  style?: ViewStyle;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  const orange = selected || filled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      aria-pressed={selected}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        {
          minHeight: 44,
          minWidth: 44,
          justifyContent: "center",
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 12,
          backgroundColor: orange ? c.accent : c.card,
          borderWidth: pressed || focused ? 2 : 1,
          borderColor: c.accent,
          outlineColor: c.accent,
          outlineWidth: focused ? 2 : 0,
          outlineOffset: 2,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {children ?? (
        <Text
          style={{
            color: orange ? c.onAccent : c.ink,
            fontSize: 14,
            fontWeight: selected ? "800" : "600",
            textAlign: "center",
            textDecorationLine: selected ? "underline" : "none",
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function PickerTrigger({
  label,
  text,
  calendar,
  onPress,
}: {
  label: string;
  text: string;
  calendar?: boolean;
  onPress: () => void;
}) {
  const c = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ flexGrow: 1, minWidth: 140, gap: 5 }}>
      <Text style={{ color: c.ink, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${text}`}
        accessibilityHint={
          calendar ? "Opens the calendar and clock" : "Opens the clock"
        }
        onPress={onPress}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => ({
          minHeight: 48,
          backgroundColor: c.card,
          borderColor: c.line,
          borderWidth: focused || pressed ? 2 : 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          outlineColor: c.accent,
          outlineWidth: focused ? 2 : 0,
          outlineOffset: 2,
        })}
      >
        <Icon name={calendar ? "calendar" : "clock"} size={19} />
        <Text
          style={{ color: c.ink, fontSize: 14, flexShrink: 1, minWidth: 0 }}
        >
          {text}
        </Text>
      </Pressable>
    </View>
  );
}

function PickerDialog({
  visible,
  title,
  summary,
  panel,
  setPanel,
  children,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  summary: string;
  panel?: "date" | "time";
  setPanel?: (panel: "date" | "time") => void;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const c = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const availableHeight = Math.max(
    160,
    height - insets.top - insets.bottom - 16,
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
    >
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: c.bg,
          justifyContent: "center",
          padding: 8,
        }}
      >
        <View
          role="dialog"
          aria-modal
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={{
            alignSelf: "center",
            width: "100%",
            maxWidth: 440,
            maxHeight: availableHeight,
            flexShrink: 1,
            minHeight: 0,
            borderWidth: 1,
            borderColor: c.line,
            borderRadius: 22,
            backgroundColor: c.card,
            padding: 12,
            gap: 10,
          }}
        >
          <View style={{ gap: 4 }}>
            <Text
              accessibilityRole="header"
              style={{ color: c.ink, fontSize: 19, fontWeight: "700" }}
            >
              {title}
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: c.ink, fontSize: 14, lineHeight: 20 }}
            >
              {summary}
            </Text>
          </View>
          {panel && setPanel && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Choice
                label="Date"
                filled
                selected={panel === "date"}
                onPress={() => setPanel("date")}
                style={{ flex: 1 }}
              />
              <Choice
                label="Time"
                filled
                selected={panel === "time"}
                onPress={() => setPanel("time")}
                style={{ flex: 1 }}
              />
            </View>
          )}
          <ScrollView
            style={{ flexShrink: 1, minHeight: 0 }}
            contentContainerStyle={{ gap: 10, padding: 2 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {children}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Choice label="Cancel" onPress={onCancel} style={{ flex: 1 }} />
            <Choice
              label="Set"
              filled
              onPress={onConfirm}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Calendar({
  selected,
  anchor,
  today,
  settings,
  onMonth,
  onSelect,
}: {
  selected: string;
  anchor: string;
  today: string;
  settings: PickerSettings;
  onMonth: (date: string) => void;
  onSelect: (date: string) => void;
}) {
  const c = useTheme();
  const cells = calendarMonthDays(anchor, settings.firstDay);
  const monthLabel = Temporal.PlainDate.from(anchor).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
  });
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Choice
          label="Previous month"
          onPress={() => onMonth(shiftCalendarMonth(anchor, -1))}
        >
          <Icon name="chevron-left" />
        </Choice>
        <Text
          accessibilityRole="header"
          style={{
            flex: 1,
            color: c.ink,
            fontSize: 16,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {monthLabel}
        </Text>
        <Choice
          label="Next month"
          onPress={() => onMonth(shiftCalendarMonth(anchor, 1))}
        >
          <Icon name="chevron-right" />
        </Choice>
      </View>
      <View style={{ flexDirection: "row" }}>
        {weekdayLabels(settings.firstDay).map((day) => (
          <Text
            key={day}
            style={{
              width: "14.285714%",
              color: c.ink,
              textAlign: "center",
              fontSize: 12,
              fontWeight: "700",
            }}
          >
            {day}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {cells.map((date, index) => (
          <View
            key={date ?? `blank-${index}`}
            style={{ width: "14.285714%", padding: 1 }}
          >
            {date ? (
              <Choice
                label={`${displayDate(date, settings.dateFormat)}${date === today ? ", today" : ""}`}
                selected={date === selected}
                onPress={() => onSelect(date)}
                style={{
                  minWidth: 0,
                  paddingHorizontal: 0,
                  borderRadius: 10,
                  borderWidth: date === today ? 2 : 1,
                  borderStyle: date === today ? "dashed" : "solid",
                  borderColor:
                    date === today && date === selected ? c.white : c.line,
                }}
              >
                <Text
                  style={{
                    color: date === selected ? c.onAccent : c.ink,
                    fontSize: 14,
                    fontWeight:
                      date === selected || date === today ? "800" : "500",
                    textDecorationLine:
                      date === selected ? "underline" : "none",
                  }}
                >
                  {Number(date.slice(8, 10))}
                </Text>
              </Choice>
            ) : (
              <View style={{ height: 44 }} />
            )}
          </View>
        ))}
      </View>
      <Choice
        label="Today"
        onPress={() => {
          onMonth(shiftCalendarMonth(today, 0));
          onSelect(today);
        }}
      />
    </View>
  );
}

function Clock({
  value,
  clockFormat,
  onChange,
}: {
  value: string;
  clockFormat: Settings["clockFormat"];
  onChange: (time: string) => void;
}) {
  const c = useTheme();
  const [part, setPart] = useState<"hour" | "minute">("hour");
  const minuteScroll = useRef<ScrollView>(null);
  const parts = toClockParts(value, clockFormat);
  const half = clockFormat === "24" && parts.hour >= 12 ? 12 : 0;
  const hours =
    clockFormat === "12"
      ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
      : Array.from({ length: 12 }, (_, i) => half + i);
  const chooseHour = (hour: number) =>
    onChange(fromClockParts(hour, parts.minute, clockFormat, parts.period));
  const chooseMinute = (minute: number) =>
    onChange(fromClockParts(parts.hour, minute, clockFormat, parts.period));
  const scrollToMinute = () =>
    minuteScroll.current?.scrollTo({
      y: Math.max(0, Math.floor(parts.minute / 5) * 48 - 72),
      animated: false,
    });
  const angle = ((parts.hour % 12) * Math.PI) / 6;
  const handLength = 64;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Choice
          label={`Hour\n${String(parts.hour).padStart(2, "0")}`}
          selected={part === "hour"}
          onPress={() => setPart("hour")}
          style={{ flex: 1 }}
        />
        <Choice
          label={`Minute\n${String(parts.minute).padStart(2, "0")}`}
          selected={part === "minute"}
          onPress={() => setPart("minute")}
          style={{ flex: 1 }}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {clockFormat === "12"
          ? (["am", "pm"] as const).map((period) => (
              <Choice
                key={period}
                label={period.toUpperCase()}
                selected={parts.period === period}
                onPress={() =>
                  onChange(
                    fromClockParts(
                      parts.hour,
                      parts.minute,
                      clockFormat,
                      period,
                    ),
                  )
                }
                style={{ flex: 1 }}
              />
            ))
          : [0, 12].map((base) => (
              <Choice
                key={base}
                label={base === 0 ? "00–11" : "12–23"}
                accessibilityLabel={
                  base === 0 ? "Hours 00 to 11" : "Hours 12 to 23"
                }
                selected={half === base}
                onPress={() => chooseHour((parts.hour % 12) + base)}
                style={{ flex: 1 }}
              />
            ))}
      </View>
      {part === "hour" ? (
        <View
          style={{
            alignSelf: "center",
            width: 244,
            height: 244,
            borderRadius: 122,
            borderWidth: 2,
            borderColor: c.line,
            backgroundColor: c.card,
          }}
        >
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 121 + (Math.sin(angle) * handLength) / 2 - 1,
              top: 121 - (Math.cos(angle) * handLength) / 2 - handLength / 2,
              width: 2,
              height: handLength,
              backgroundColor: c.accent,
              transform: [{ rotate: `${(parts.hour % 12) * 30}deg` }],
            }}
          />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 117,
              top: 117,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: c.accent,
            }}
          />
          {hours.map((hour, index) => {
            const position = (index * Math.PI) / 6;
            return (
              <Choice
                key={hour}
                label={
                  clockFormat === "24"
                    ? String(hour).padStart(2, "0")
                    : String(hour)
                }
                accessibilityLabel={`Hour ${hour}`}
                selected={parts.hour === hour}
                onPress={() => chooseHour(hour)}
                style={{
                  position: "absolute",
                  width: 44,
                  height: 44,
                  left: 121 + Math.sin(position) * 96 - 22,
                  top: 121 - Math.cos(position) * 96 - 22,
                  borderRadius: 22,
                  padding: 0,
                }}
              />
            );
          })}
        </View>
      ) : (
        <ScrollView
          ref={minuteScroll}
          onContentSizeChange={scrollToMinute}
          style={{ maxHeight: 244 }}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {Array.from({ length: 60 }, (_, minute) => (
              <View key={minute} style={{ width: "20%", padding: 2 }}>
                <Choice
                  label={String(minute).padStart(2, "0")}
                  accessibilityLabel={`Minute ${minute}`}
                  selected={parts.minute === minute}
                  onPress={() => chooseMinute(minute)}
                  style={{ minWidth: 0, paddingHorizontal: 0 }}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

export function DateTimePickerField({
  label,
  value,
  onChange,
  settings,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  settings: PickerSettings;
}) {
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState("");
  const [panel, setPanel] = useState<"date" | "time">("date");
  let display = "Choose date and time";
  let valid = false;
  try {
    display = formatPickerDateTime(
      value,
      settings.dateFormat,
      settings.clockFormat,
    );
    valid = true;
  } catch {
    /* Incomplete form values stay untouched until the user chooses Set. */
  }
  const open = () => {
    const initial = valid
      ? value
      : localAt(systemClock.now(), settings.timezone);
    setDraft(initial);
    setAnchor(shiftCalendarMonth(initial.slice(0, 10), 0));
    setPanel("date");
    setVisible(true);
  };
  return (
    <>
      <PickerTrigger label={label} text={display} calendar onPress={open} />
      {visible && (
        <PickerDialog
          visible
          title={label}
          summary={formatPickerDateTime(
            draft,
            settings.dateFormat,
            settings.clockFormat,
          )}
          panel={panel}
          setPanel={setPanel}
          onCancel={() => setVisible(false)}
          onConfirm={() => {
            setVisible(false);
            onChange(draft);
          }}
        >
          {panel === "date" ? (
            <Calendar
              selected={draft.slice(0, 10)}
              anchor={anchor}
              today={dateInZone(systemClock, settings.timezone)}
              settings={settings}
              onMonth={setAnchor}
              onSelect={(date) => setDraft(replacePickerDate(draft, date))}
            />
          ) : (
            <Clock
              value={draft.slice(11, 16)}
              clockFormat={settings.clockFormat}
              onChange={(time) => setDraft(replacePickerTime(draft, time))}
            />
          )}
        </PickerDialog>
      )}
    </>
  );
}

export function TimePickerField({
  label,
  value,
  onChange,
  clockFormat,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  clockFormat: Settings["clockFormat"];
}) {
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState("00:00");
  let display = "Choose time";
  let valid = false;
  try {
    display = formatPickerTime(value, clockFormat);
    valid = true;
  } catch {
    /* An empty or incomplete editor value is not replaced on opening. */
  }
  return (
    <>
      <PickerTrigger
        label={label}
        text={display}
        onPress={() => {
          setDraft(valid ? value : "00:00");
          setVisible(true);
        }}
      />
      {visible && (
        <PickerDialog
          visible
          title={label}
          summary={formatPickerTime(draft, clockFormat)}
          onCancel={() => setVisible(false)}
          onConfirm={() => {
            setVisible(false);
            onChange(draft);
          }}
        >
          <Clock value={draft} clockFormat={clockFormat} onChange={setDraft} />
        </PickerDialog>
      )}
    </>
  );
}
