export const SAVED_FEEDBACK_MS = 3000;
export const UNDO_FEEDBACK_MS = 60000;

export interface HeaderFeedbackSnapshot {
  status: string;
  canUndo: boolean;
}
export interface HeaderFeedbackSource {
  getSnapshot(): HeaderFeedbackSnapshot;
  subscribe(listener: () => void): () => void;
}
export interface SaveTicket {
  readonly scope: symbol;
  readonly generation: number;
  readonly save: number;
  readonly edit: number;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSnapshot(value, right[index]))
    );
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length ===
      Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameSnapshot(a[key], b[key]))
  );
}

/** Ephemeral feedback and undo history; never reads or writes saved data. */
export function createHeaderFeedback<T>({
  initialStatus = "",
}: { initialStatus?: string } = {}) {
  const scope = Symbol("header feedback"),
    listeners = new Set<() => void>();
  let active = true,
    generation = 0,
    editRevision = 0,
    saveRevision = 0;
  let history: T[] = [];
  let snapshot: HeaderFeedbackSnapshot = {
    status: initialStatus,
    canUndo: false,
  };
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  function update(status = snapshot.status) {
    const canUndo = history.length > 0;
    if (snapshot.status === status && snapshot.canUndo === canUndo) return;
    snapshot = { status, canUndo };
    listeners.forEach((listener) => listener());
  }
  function clearSaved() {
    clearTimeout(savedTimer);
    savedTimer = undefined;
  }
  function clearUndo() {
    clearTimeout(undoTimer);
    undoTimer = undefined;
  }
  function changed() {
    ++editRevision;
    clearSaved();
    if (snapshot.status === "Saved to your account") update("");
    clearUndo();
    if (history.length) {
      const edit = editRevision,
        lifecycle = generation;
      undoTimer = setTimeout(() => {
        if (!active || lifecycle !== generation || edit !== editRevision)
          return;
        history = [];
        undoTimer = undefined;
        update();
      }, UNDO_FEEDBACK_MS);
    }
    update();
  }
  function current(ticket: SaveTicket) {
    return (
      active &&
      ticket.scope === scope &&
      ticket.generation === generation &&
      ticket.save === saveRevision &&
      ticket.edit === editRevision
    );
  }
  function reset(enabled: boolean) {
    active = enabled;
    ++generation;
    ++saveRevision;
    editRevision = 0;
    history = [];
    clearSaved();
    clearUndo();
    update(enabled ? initialStatus : "");
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate: () => reset(true),
    deactivate: () => reset(false),
    edit(before: T, after: T, undoable = true): boolean {
      if (!active || sameSnapshot(before, after)) return false;
      if (undoable) {
        history.push(before);
        if (history.length > 12) history.shift();
      } else history = [];
      changed();
      return true;
    },
    undo(): T | undefined {
      if (!active || !history.length) return undefined;
      const previous = history.pop()!;
      changed();
      return previous;
    },
    beginSave(): SaveTicket {
      const ticket = {
        scope,
        generation,
        save: ++saveRevision,
        edit: editRevision,
      };
      if (active) {
        clearSaved();
        update("Saving your account…");
      }
      return ticket;
    },
    saved(ticket: SaveTicket, { offline }: { offline: boolean }): boolean {
      if (!current(ticket)) return false;
      clearSaved();
      if (offline) update("Saved on device · sync pending");
      else if (ticket.edit === 0) update("");
      else {
        update("Saved to your account");
        savedTimer = setTimeout(() => {
          if (current(ticket)) update("");
          savedTimer = undefined;
        }, SAVED_FEEDBACK_MS);
      }
      return true;
    },
    failed(ticket: SaveTicket): boolean {
      if (!current(ticket)) return false;
      clearSaved();
      update("Save failed");
      return true;
    },
  };
}
