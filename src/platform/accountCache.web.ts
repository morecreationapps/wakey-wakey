export interface AccountCache {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function storage(): Storage {
  if (typeof localStorage === "undefined")
    throw new Error(
      "Local browser storage is unavailable. Your saved records have not been removed.",
    );
  return localStorage;
}

/** Keys are supplied by an immutable account-bound store; legacy data is untouched. */
export const accountCache: AccountCache = {
  async getItem(key) {
    return storage().getItem(key);
  },
  async setItem(key, value) {
    storage().setItem(key, value);
  },
  async removeItem(key) {
    storage().removeItem(key);
  },
};
