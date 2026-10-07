import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

// Chunk provider sessions to respect native secure-store value limits. Publish
// the manifest last, so an interrupted write cannot expose a partial session.
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_");
interface Manifest {
  generation: string;
  chunks: number;
}
async function manifest(key: string): Promise<Manifest | null> {
  const value = await SecureStore.getItemAsync(safeKey(key));
  if (!value) return null;
  const result = JSON.parse(value) as Manifest;
  if (
    typeof result.generation !== "string" ||
    !Number.isInteger(result.chunks) ||
    result.chunks < 1 ||
    result.chunks > 100
  )
    throw new Error("Invalid secure session manifest");
  return result;
}
async function removeChunks(key: string, value: Manifest | null) {
  if (!value) return;
  await Promise.all(
    Array.from({ length: value.chunks }, (_, i) =>
      SecureStore.deleteItemAsync(`${safeKey(key)}.${value.generation}.${i}`),
    ),
  );
}
export const sessionStorage = {
  async getItem(key: string) {
    const value = await manifest(key);
    if (!value) return null;
    const pieces = await Promise.all(
      Array.from({ length: value.chunks }, (_, i) =>
        SecureStore.getItemAsync(`${safeKey(key)}.${value.generation}.${i}`),
      ),
    );
    if (pieces.some((value) => value === null))
      throw new Error("Incomplete secure session. Log in again.");
    return pieces.join("");
  },
  async setItem(key: string, text: string) {
    const previous = await manifest(key);
    const value = {
      generation: Crypto.randomUUID(),
      chunks: Math.max(1, Math.ceil(text.length / 1000)),
    };
    for (let i = 0; i < value.chunks; i++)
      await SecureStore.setItemAsync(
        `${safeKey(key)}.${value.generation}.${i}`,
        text.slice(i * 1000, (i + 1) * 1000),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
    await SecureStore.setItemAsync(safeKey(key), JSON.stringify(value), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await removeChunks(key, previous);
  },
  async removeItem(key: string) {
    const previous = await manifest(key);
    await SecureStore.deleteItemAsync(safeKey(key));
    await removeChunks(key, previous);
  },
};
