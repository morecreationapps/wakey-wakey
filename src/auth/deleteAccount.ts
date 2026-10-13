export interface DeletionSession {
  userId: string;
  token: string;
}
export interface AccountDeletionDependencies {
  currentUserId(): Promise<string | null>;
  reauthenticate(email: string, password: string): Promise<DeletionSession>;
  deleteRemote(token: string): Promise<void>;
  releaseSession(token: string): Promise<void>;
}

/** Password is transient, passed only to Auth; the Edge endpoint receives a token. */
export async function deleteOwnAccount(
  input: {
    userId: string;
    email: string;
    password: string;
    confirmation: string;
  },
  deps: AccountDeletionDependencies,
): Promise<void> {
  if (input.confirmation !== "DELETE")
    throw new Error("Type DELETE to confirm permanent account deletion.");
  if (!input.password.length)
    throw new Error("Enter your current password to delete your account.");
  if ((await deps.currentUserId()) !== input.userId)
    throw new Error("The active account changed. Open Settings again.");
  const session = await deps.reauthenticate(input.email, input.password);
  let deleted = false;
  try {
    if (
      session.userId !== input.userId ||
      (await deps.currentUserId()) !== input.userId
    )
      throw new Error("The active account changed. Open Settings again.");
    await deps.deleteRemote(session.token);
    deleted = true;
  } finally {
    // Failed/cancelled deletion must not leave this temporary login active.
    // Successful hard deletion already removes all sessions on the server.
    if (!deleted)
      await deps.releaseSession(session.token).catch(() => undefined);
  }
}

/** Exact owner boundary prevents deleting another account or a neighbouring key. */
export function accountCacheKeysToDelete(
  keys: string[],
  userId: string,
): string[] {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(userId))
    throw new Error("A verified account ID is required.");
  const prefix = `wakey-wakey:account:v1:${userId.toLowerCase()}`;
  return keys.filter((key) => key === prefix || key.startsWith(`${prefix}:`));
}
