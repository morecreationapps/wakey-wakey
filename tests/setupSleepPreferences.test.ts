import React from "react";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Settings } from "../src/model";
import { initialState } from "../src/data/defaults";
const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup: (node: React.ReactNode) => string };

interface PickerContract {
  label: string;
  value: string;
  clockFormat: "24" | "12";
  allowClear: boolean;
  hint: string;
  onChange: (value: string) => void;
}
interface ButtonContract {
  title: string;
  onPress: () => void;
}
const controls = vi.hoisted(() => ({
  pickers: [] as PickerContract[],
  buttons: [] as ButtonContract[],
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});
vi.mock("../src/ui/DateTimePickers", async () => {
  const React = await import("react");
  return {
    TimePickerField: (props: PickerContract) => {
      controls.pickers.push(props);
      return React.createElement("span", null, props.label);
    },
  };
});
vi.mock("../src/ui/components", async () => {
  const React = await import("react");
  const container = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Card: container,
    Row: container,
    Body: container,
    Heading: container,
    Notice: container,
    Field: () => null,
    Toggle: () => null,
    Choices: () => null,
    Pill: ({ text }: { text: string }) =>
      React.createElement("span", null, text),
    Button: (props: ButtonContract) => {
      controls.buttons.push(props);
      return React.createElement("button", null, props.title);
    },
    useTheme: () => ({ card: "#FFFFFF", accent: "#FA5501" }),
    ui: { stack: {} },
  };
});

import { SettingsFields, Setup } from "../src/ui/Setup";

const pairs = [
  ["beforeEarlyBed", "Bedtime before an early shift"],
  ["beforeEarlyWake", "Wake-up for the early shift"],
  ["beforeLateBed", "Bedtime before a late shift"],
  ["beforeLateWake", "Wake-up for the late shift"],
] as const;

function renderSleep(patch: Partial<Settings> = {}, onboarding = false) {
  let state: AppState = initialState();
  state = {
    ...state,
    settings: { ...state.settings, onboardingStep: 3, ...patch },
  };
  const original = structuredClone(state);
  const notify = vi.fn();
  const change = (update: (current: AppState) => AppState) => {
    state = update(state);
  };
  const markup = renderToStaticMarkup(
    onboarding
      ? React.createElement(Setup, { state, change, notify })
      : React.createElement(SettingsFields, { state, change, section: 3 }),
  );
  return { getState: () => state, original, markup, notify };
}

beforeEach(() => {
  controls.pickers.length = 0;
  controls.buttons.length = 0;
});

describe("shared onboarding and Settings sleep preferences", () => {
  it("shows both optional previous-night pairs alongside the six existing usual times", () => {
    const { markup } = renderSleep();
    expect(markup).toContain("Night before an early shift");
    expect(markup).toContain("Night before a late shift");
    expect(markup).toContain("previous calendar day");
    expect(markup).toContain("planning estimates");
    expect(controls.pickers.map((p) => p.label)).toEqual([
      "Early-shift bedtime",
      "Early-shift wake",
      "Late-shift bedtime",
      "Late-shift wake",
      "Rest-day bedtime",
      "Rest-day wake",
      ...pairs.map(([, label]) => label),
    ]);
    for (const [, label] of pairs) {
      const picker = controls.pickers.find((p) => p.label === label)!;
      expect(picker.value).toBe("");
      expect(picker.allowClear).toBe(true);
      expect(picker.hint).toMatch(/Optional/);
    }
  });

  it("renders absent older snapshot keys as optional blank controls in the selected clock format", () => {
    renderSleep({
      beforeEarlyBed: undefined,
      beforeEarlyWake: undefined,
      beforeLateBed: undefined,
      beforeLateWake: undefined,
      clockFormat: "12",
    });
    for (const [, label] of pairs) {
      const picker = controls.pickers.find((p) => p.label === label)!;
      expect(picker.value).toBe("");
      expect(picker.clockFormat).toBe("12");
      expect(picker.hint).not.toContain("Entered by you");
    }
  });

  it.each(pairs)(
    "saves a picked %s without changing the existing usual times",
    (key, label) => {
      const context = renderSleep({
        earlyBed: "21:00",
        lateWake: "07:00",
        restBed: "23:00",
      });
      controls.pickers.find((p) => p.label === label)!.onChange("20:30");
      expect(context.getState().settings[key]).toBe("20:30");
      expect(context.getState().settings.origins[key]).toBe("entered");
      expect(context.getState().settings.earlyBed).toBe(
        context.original.settings.earlyBed,
      );
      expect(context.getState().settings.lateWake).toBe(
        context.original.settings.lateWake,
      );
      expect(context.getState().settings.restBed).toBe(
        context.original.settings.restBed,
      );
      expect(context.getState().entries).toEqual(context.original.entries);
      expect(context.getState().tasks).toEqual(context.original.tasks);
    },
  );

  it.each(pairs)(
    "clears %s instead of inventing a replacement time",
    (key, label) => {
      const context = renderSleep({ [key]: "20:30" });
      controls.pickers.find((p) => p.label === label)!.onChange("");
      expect(context.getState().settings[key]).toBeNull();
      expect(context.getState().settings.origins[key]).toBe("needed");
    },
  );

  it("keeps new optional times blank when confirming suggested durations", () => {
    const context = renderSleep();
    controls.buttons
      .find((b) => b.title === "Confirm the suggested durations")!
      .onPress();
    for (const [key] of pairs)
      expect(context.getState().settings[key]).toBeNull();
    expect(context.getState().settings.origins.sleepTarget).toBe("entered");
  });

  it("allows onboarding to continue when optional times are unset", () => {
    const context = renderSleep(
      {
        beforeEarlyBed: undefined,
        beforeEarlyWake: null,
        beforeLateBed: undefined,
        beforeLateWake: null,
      },
      true,
    );
    controls.buttons.find((b) => b.title === "Save & continue")!.onPress();
    expect(context.getState().settings.onboardingStep).toBe(4);
    expect(context.notify).not.toHaveBeenCalled();
  });

  it.each(pairs)(
    "rejects an invalid optional %s before advancing onboarding",
    (key) => {
      const context = renderSleep({ [key]: "25:00" }, true);
      controls.buttons.find((b) => b.title === "Save & continue")!.onPress();
      expect(context.getState().settings.onboardingStep).toBe(3);
      expect(context.notify).toHaveBeenCalledWith(
        "Choose valid usual sleep times, or clear unknown times.",
      );
    },
  );

  it("shows the new preferences on review using the chosen clock without filling missing times", () => {
    const { markup } = renderSleep(
      {
        onboardingStep: 5,
        clockFormat: "12",
        beforeEarlyBed: "20:30",
        beforeEarlyWake: "05:00",
        beforeLateBed: "23:00",
        beforeLateWake: null,
      },
      true,
    );
    expect(markup).toContain("Night before an early shift: bedtime 08:30 pm");
    expect(markup).toContain("wake-up 05:00 am");
    expect(markup).toContain("Night before a late shift: bedtime 11:00 pm");
    expect(markup).toContain("wake-up Not set");
  });
});
