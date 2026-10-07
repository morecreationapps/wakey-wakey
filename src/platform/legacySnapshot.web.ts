import { WEB_STORAGE_KEY } from "./store.web";
export async function readLegacySnapshot() {
  return localStorage.getItem(WEB_STORAGE_KEY);
}
