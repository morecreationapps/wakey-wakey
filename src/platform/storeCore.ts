import { AppState } from "../model";
import { parseBackup } from "../data/backup";

/** The same durable snapshot operations run against Expo SQLite and a test adapter. */
export interface SnapshotQueries {
  execAsync(sql: string): Promise<void>;
  runAsync(
    sql: string,
    ...params: (string | number | null)[]
  ): Promise<unknown>;
  getFirstAsync<T>(
    sql: string,
    ...params: (string | number | null)[]
  ): Promise<T | null>;
}
export interface SnapshotDatabase extends SnapshotQueries {
  withExclusiveTransactionAsync(
    task: (transaction: SnapshotQueries) => Promise<void>,
  ): Promise<void>;
}

export function createSnapshotStore(open: () => Promise<SnapshotDatabase>) {
  let opened: Promise<SnapshotDatabase> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  function database() {
    if (!opened) {
      opened = (async () => {
        const db = await open();
        const version = await db.getFirstAsync<{ user_version: number }>(
          "PRAGMA user_version",
        );
        if ((version?.user_version ?? 0) > 1)
          throw new Error(
            "This saved database needs a newer version of Wakey-Wakey!.",
          );
        // These statements contain no user input. Values below always use bound parameters.
        await db.execAsync(
          "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
        );
        await db.withExclusiveTransactionAsync(async (transaction) => {
          await transaction.execAsync(
            "CREATE TABLE IF NOT EXISTS app_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL);",
          );
          await transaction.execAsync("PRAGMA user_version = 1;");
        });
        return db;
      })().catch((error) => {
        opened = undefined;
        throw error;
      });
    }
    return opened;
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation);
    // A failure reaches its caller but does not poison all later saves.
    tail = next.catch(() => undefined);
    return next;
  }
  return {
    loadState(): Promise<AppState | null> {
      return serial(async () => {
        const db = await database();
        const row = await db.getFirstAsync<{
          schema_version: number;
          payload: string;
        }>("SELECT schema_version, payload FROM app_snapshot WHERE id = ?", 1);
        if (!row) return null;
        if (row.schema_version !== 1)
          throw new Error(
            "This saved snapshot needs a newer version of Wakey-Wakey!.",
          );
        // Invalid data is reported and retained, never silently replaced with an empty rota.
        return parseBackup(row.payload);
      });
    },
    async saveState(state: AppState): Promise<void> {
      // Capture this exact revision now, before another queued update can mutate it.
      const payload = JSON.stringify(state);
      parseBackup(payload);
      return serial(async () => {
        const db = await database();
        await db.withExclusiveTransactionAsync(async (transaction) => {
          await transaction.runAsync(
            "INSERT INTO app_snapshot (id, schema_version, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, payload = excluded.payload",
            1,
            1,
            payload,
          );
        });
      });
    },
    deleteState(): Promise<void> {
      return serial(async () => {
        const db = await database();
        await db.withExclusiveTransactionAsync(async (transaction) => {
          await transaction.runAsync(
            "DELETE FROM app_snapshot WHERE id = ?",
            1,
          );
        });
      });
    },
  };
}
