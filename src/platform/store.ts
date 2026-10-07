import * as SQLite from "expo-sqlite";
import { createSnapshotStore } from "./storeCore";

// Ordinary local SQLite storage. Database encryption is not enabled.
const store = createSnapshotStore(() =>
  SQLite.openDatabaseAsync("wakey-wakey.db"),
);
export const { loadState, saveState, deleteState } = store;
