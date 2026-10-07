import { loadState } from "./store";
export async function readLegacySnapshot() {
  const state = await loadState();
  return state ? JSON.stringify(state) : null;
}
