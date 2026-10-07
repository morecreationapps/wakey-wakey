import { AppState } from "../model";
import { parseBackup } from "../data/backup";

export const WEB_STORAGE_KEY = "wakey-wakey:snapshot:v1";
function storage(): Storage {
  if (typeof localStorage === "undefined")
    throw new Error(
      "Local browser storage is unavailable. Enable storage or use the mobile app.",
    );
  return localStorage;
}
export async function loadState(): Promise<AppState | null> {
  const payload = storage().getItem(WEB_STORAGE_KEY);
  return payload === null ? null : parseBackup(payload);
}
export async function saveState(state: AppState): Promise<void> {
  const payload = JSON.stringify(state);
  parseBackup(payload);
  // localStorage writes are atomic and synchronous; quota/permission errors reach the UI.
  storage().setItem(WEB_STORAGE_KEY, payload);
}
export async function deleteState(): Promise<void> {
  storage().removeItem(WEB_STORAGE_KEY);
}
