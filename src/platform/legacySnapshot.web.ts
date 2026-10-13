import { WEB_STORAGE_KEY } from "./store.web";
export async function readLegacySnapshot() {
  return localStorage.getItem(WEB_STORAGE_KEY);
}
export async function removeLegacySnapshotIfMatches(
  payload: string,
): Promise<void> {
  if (localStorage.getItem(WEB_STORAGE_KEY) === payload)
    localStorage.removeItem(WEB_STORAGE_KEY);
}
