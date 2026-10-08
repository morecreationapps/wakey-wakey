import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeaderFeedback } from "../src/ui/editFeedback";

const state = (value: number) => ({ value });

describe("temporary header feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows no success or Undo on initial load, including its initial save", () => {
    const feedback = createHeaderFeedback({
      initialStatus: "Loading account data…",
    });
    const ticket = feedback.beginSave();
    expect(feedback.getSnapshot()).toEqual({
      status: "Saving your account…",
      canUndo: false,
    });
    expect(feedback.saved(ticket, { offline: false })).toBe(true);
    expect(feedback.getSnapshot()).toEqual({ status: "", canUndo: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Saving visible until completion, then shows success for exactly three seconds", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    const ticket = feedback.beginSave();
    vi.advanceTimersByTime(4000);
    expect(feedback.getSnapshot().status).toBe("Saving your account…");
    feedback.saved(ticket, { offline: false });
    vi.advanceTimersByTime(2999);
    expect(feedback.getSnapshot()).toEqual({
      status: "Saved to your account",
      canUndo: true,
    });
    vi.advanceTimersByTime(1);
    expect(feedback.getSnapshot()).toEqual({ status: "", canUndo: true });
  });

  it("expires Undo sixty seconds after the edit even when the save finishes later", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    const ticket = feedback.beginSave();
    vi.advanceTimersByTime(50000);
    feedback.saved(ticket, { offline: false });
    vi.advanceTimersByTime(9999);
    expect(feedback.getSnapshot().canUndo).toBe(true);
    vi.advanceTimersByTime(1);
    expect(feedback.getSnapshot()).toEqual({ status: "", canUndo: false });
    expect(feedback.undo()).toBeUndefined();
  });

  it("restarts the Undo deadline after another actual edit", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    vi.advanceTimersByTime(40000);
    feedback.edit(state(1), state(2));
    vi.advanceTimersByTime(59999);
    expect(feedback.getSnapshot().canUndo).toBe(true);
    vi.advanceTimersByTime(1);
    expect(feedback.getSnapshot().canUndo).toBe(false);
  });

  it("does not create or restart Undo for equivalent snapshots or key reordering", () => {
    const feedback = createHeaderFeedback();
    const before = {
      settings: { firstDay: "Monday", format: "UK" },
      entries: ["2026-10-10"],
    };
    const after = {
      settings: { firstDay: "Saturday", format: "UK" },
      entries: ["2026-10-10"],
    };
    expect(feedback.edit(before, { ...before })).toBe(false);
    expect(feedback.getSnapshot().canUndo).toBe(false);
    feedback.edit(before, after);
    vi.advanceTimersByTime(45000);
    expect(
      feedback.edit(after, {
        entries: ["2026-10-10"],
        settings: { format: "UK", firstDay: "Saturday" },
      }),
    ).toBe(false);
    vi.advanceTimersByTime(15000);
    expect(feedback.getSnapshot().canUndo).toBe(false);
  });

  it("ignores unchanged optional values but treats null and changed nested values as edits", () => {
    const feedback = createHeaderFeedback();
    expect(feedback.edit({ value: 1 }, { value: 1, optional: undefined })).toBe(
      false,
    );
    expect(feedback.edit({ value: 1 }, { value: 1, optional: null })).toBe(
      true,
    );
  });

  it("does not resurrect expired history after a later edit", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    feedback.edit(state(1), state(2));
    vi.advanceTimersByTime(60000);
    feedback.edit(state(2), state(3));
    expect(feedback.undo()).toEqual(state(2));
    expect(feedback.undo()).toBeUndefined();
    expect(feedback.getSnapshot().canUndo).toBe(false);
  });

  it("restores the prior snapshot and invalidates a pending save when Undo is used", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    feedback.edit(state(1), state(2));
    const ticket = feedback.beginSave();
    vi.advanceTimersByTime(30000);
    expect(feedback.undo()).toEqual(state(1));
    expect(feedback.saved(ticket, { offline: false })).toBe(false);
    expect(feedback.failed(ticket)).toBe(false);
    const undoSave = feedback.beginSave();
    feedback.saved(undoSave, { offline: false });
    vi.advanceTimersByTime(59999);
    expect(feedback.getSnapshot().canUndo).toBe(true);
    expect(feedback.undo()).toEqual(state(0));
    expect(feedback.getSnapshot().canUndo).toBe(false);
  });

  it("restarts the success timer for the newest successful save without extending Undo", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    feedback.saved(feedback.beginSave(), { offline: false });
    vi.advanceTimersByTime(2000);
    feedback.saved(feedback.beginSave(), { offline: false });
    vi.advanceTimersByTime(2999);
    expect(feedback.getSnapshot().status).toBe("Saved to your account");
    vi.advanceTimersByTime(1);
    expect(feedback.getSnapshot().status).toBe("");
    vi.advanceTimersByTime(55000);
    expect(feedback.getSnapshot().canUndo).toBe(false);
  });

  it("ignores an older save completion when a newer save is pending or complete", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    const older = feedback.beginSave(),
      newer = feedback.beginSave();
    expect(feedback.saved(older, { offline: false })).toBe(false);
    expect(feedback.failed(older)).toBe(false);
    expect(feedback.getSnapshot().status).toBe("Saving your account…");
    feedback.saved(newer, { offline: false });
    vi.advanceTimersByTime(2000);
    expect(feedback.saved(older, { offline: false })).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(feedback.getSnapshot().status).toBe("");
  });

  it("invalidates an old completion immediately on edit, before the next save starts", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    const ticket = feedback.beginSave();
    feedback.edit(state(1), state(2));
    expect(feedback.saved(ticket, { offline: false })).toBe(false);
    expect(feedback.failed(ticket)).toBe(false);
    expect(feedback.getSnapshot().status).toBe("Saving your account…");
  });

  it.each(["saving", "offline", "failure"])(
    "does not time out %s status",
    (result) => {
      const feedback = createHeaderFeedback();
      feedback.edit(state(0), state(1));
      const ticket = feedback.beginSave();
      if (result === "offline") feedback.saved(ticket, { offline: true });
      else if (result === "failure") feedback.failed(ticket);
      const status = feedback.getSnapshot().status;
      vi.advanceTimersByTime(3600000);
      expect(feedback.getSnapshot()).toEqual({ status, canUndo: false });
    },
  );

  it("keeps an offline initial save visible without inventing edit history", () => {
    const feedback = createHeaderFeedback();
    feedback.saved(feedback.beginSave(), { offline: true });
    vi.advanceTimersByTime(60000);
    expect(feedback.getSnapshot()).toEqual({
      status: "Saved on device · sync pending",
      canUndo: false,
    });
  });

  it.each(["logout", "access denial", "unmount"])(
    "cancels timers and stale completions on %s",
    () => {
      const feedback = createHeaderFeedback();
      feedback.edit(state(0), state(1));
      const ticket = feedback.beginSave();
      feedback.saved(ticket, { offline: false });
      const listener = vi.fn();
      feedback.subscribe(listener);
      feedback.deactivate();
      listener.mockClear();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(120000);
      expect(listener).not.toHaveBeenCalled();
      expect(feedback.saved(ticket, { offline: false })).toBe(false);
      expect(feedback.failed(ticket)).toBe(false);
      expect(feedback.edit(state(1), state(2))).toBe(false);
      expect(feedback.undo()).toBeUndefined();
      expect(feedback.getSnapshot()).toEqual({ status: "", canUndo: false });
      feedback.activate();
      expect(feedback.saved(ticket, { offline: false })).toBe(false);
      feedback.saved(feedback.beginSave(), { offline: false });
      expect(feedback.getSnapshot()).toEqual({ status: "", canUndo: false });
    },
  );

  it("rejects save tickets belonging to another feedback controller", () => {
    const first = createHeaderFeedback(),
      second = createHeaderFeedback();
    first.edit(state(0), state(1));
    second.edit(state(0), state(1));
    const old = first.beginSave(),
      current = second.beginSave();
    expect(second.saved(old, { offline: false })).toBe(false);
    expect(second.saved(current, { offline: false })).toBe(true);
  });

  it("clears Undo history for an intentional reset without retaining a hidden timer", () => {
    const feedback = createHeaderFeedback();
    feedback.edit(state(0), state(1));
    feedback.edit(state(1), state(2), false);
    expect(feedback.getSnapshot().canUndo).toBe(false);
    expect(feedback.undo()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds recent history at twelve real edits", () => {
    const feedback = createHeaderFeedback();
    for (let i = 0; i < 15; i++) feedback.edit(state(i), state(i + 1));
    for (let i = 14; i >= 3; i--) expect(feedback.undo()).toEqual(state(i));
    expect(feedback.undo()).toBeUndefined();
  });

  it("provides stable snapshots and respects observer cleanup", () => {
    const feedback = createHeaderFeedback();
    expect(feedback.getSnapshot()).toBe(feedback.getSnapshot());
    const observer = vi.fn(),
      unsubscribe = feedback.subscribe(observer);
    feedback.edit(state(0), state(1));
    expect(observer).toHaveBeenCalledOnce();
    unsubscribe();
    feedback.beginSave();
    vi.advanceTimersByTime(60000);
    expect(observer).toHaveBeenCalledOnce();
  });
});
