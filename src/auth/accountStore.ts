import { AppState } from "../model";
import { initialState } from "../data/defaults";
import { parseBackup } from "../data/backup";
import type { AccountCache } from "../platform/accountCache";

export const ACCOUNT_CACHE_PREFIX = "wakey-wakey:account:v1:";
// A remount/account switch can create a second store while an earlier save is
// finishing. Share ordering by immutable owner key within this process.
const accountQueues = new Map<string, Promise<unknown>>();
export type AccountStoreErrorCode =
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "PERMISSION_ERROR"
  | "SETUP_PENDING"
  | "CONFLICT"
  | "CORRUPT_DATA"
  | "CACHE_ERROR"
  | "MIGRATION_REQUIRED"
  | "NOT_LOADED";

export class AccountStoreError extends Error {
  constructor(
    public readonly code: AccountStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountStoreError";
  }
}

/** Only the backend's exact trusted setup gate is recoverable without logout. */
export function accountAccessError(
  status: number,
  response: unknown,
): AccountStoreError | null {
  const error =
    typeof response === "object" && response !== null
      ? (response as { code?: unknown; message?: unknown })
      : {};
  if (status === 401)
    return new AccountStoreError(
      "AUTH_ERROR",
      "Your session needs a fresh password login.",
    );
  if (status === 403 || error.code === "42501") {
    if (
      status === 403 &&
      error.code === "42501" &&
      error.message ===
        "Administrator setup is awaiting trusted migration approval."
    )
      return new AccountStoreError("SETUP_PENDING", error.message);
    return new AccountStoreError(
      "PERMISSION_ERROR",
      "The server did not permit access to this account's planner.",
    );
  }
  return null;
}

/** Explicit access rejection hides the active view without deleting its cache. */
export function handleAccountAccessDenied(
  error: unknown,
  actions: { deactivate: () => void; logout: () => Promise<void> },
): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code !== "AUTH_ERROR" && code !== "PERMISSION_ERROR") return false;
  actions.deactivate();
  void actions.logout().catch(() => undefined);
  return true;
}

export interface RemoteSnapshot {
  payload: string | null;
  revision: number;
}
export interface MigrationStatus {
  eligible: boolean;
  completed: boolean;
  digest?: string;
}
export interface AccountRemote {
  load(): Promise<RemoteSnapshot>;
  save(
    payload: string,
    expectedRevision: number,
  ): Promise<{ payload: string; revision: number }>;
  migrationStatus(): Promise<MigrationStatus>;
  migrate(
    payload: string,
    digest: string,
  ): Promise<{ payload: string; revision: number; digest: string }>;
}
export interface AccountStoreStatus {
  loaded: boolean;
  offline: boolean;
  dirty: boolean;
  revision: number;
  migration: "none" | "eligible" | "verified" | "completed";
  message: string;
}
export interface AccountSnapshotSummary {
  revision: number;
  rotaEntries: number;
  tasks: number;
  sleepLogs: number;
  onboardingComplete: boolean;
}
export interface AccountConflictReview {
  ownerId: string;
  /** Bound to the exact versions reviewed by this store; not an auth credential. */
  token: string;
  device: { payload: string; summary: AccountSnapshotSummary };
  account: { payload: string; summary: AccountSnapshotSummary };
  recoveryKeys: { device: string; account: string };
}
export type AccountConflictRecovery = Pick<
  AccountConflictReview,
  "ownerId" | "device" | "account" | "recoveryKeys"
>;
export interface AccountConflictRecoveryRecord {
  version: 1;
  ownerId: string;
  source: "device" | "account";
  reviewToken: string;
  revision: number;
  payload: string;
  payloadDigest: string;
  /** Retains the original pending envelope and its migration receipt exactly. */
  deviceCache?: string;
}
interface CacheEnvelope {
  version: 1;
  ownerId: string;
  payload: string;
  revision: number;
  dirty: boolean;
  /** Set only after a successful verified-account backend read/write. */
  verifiedOnline: true;
  migrationDigest?: string;
}
interface LegacyBackup {
  version: 1;
  ownerId: string;
  payload: string;
  digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const sameSnapshot = (a: string, b: string) =>
  canonical(parseBackup(a)) === canonical(parseBackup(b));
const networkFailure = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "NETWORK_ERROR";
const digestValid = (digest: unknown): digest is string =>
  typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);

function validateRemote(value: RemoteSnapshot): RemoteSnapshot {
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    (value.payload === null && value.revision !== 0)
  )
    throw new AccountStoreError(
      "CORRUPT_DATA",
      "The account snapshot revision is invalid. Existing records have been retained.",
    );
  if (value.payload !== null) {
    if (typeof value.payload !== "string")
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "The account snapshot is invalid. Existing records have been retained.",
      );
    parseBackup(value.payload);
  }
  return value;
}

/** Authenticated UID is immutable. Backend ownership checks remain authoritative. */
export function createAccountStore(options: {
  userId: string;
  remote: AccountRemote;
  cache: AccountCache;
  readLegacy: () => Promise<string | null>;
  hash: (payload: string) => Promise<string>;
}) {
  const { userId, remote, cache, readLegacy, hash } = options;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      userId,
    )
  )
    throw new AccountStoreError(
      "AUTH_ERROR",
      "A valid authenticated account ID is required.",
    );
  const key = `${ACCOUNT_CACHE_PREFIX}${userId.toLowerCase()}`;
  const backupKey = `${key}:legacy-backup:v1`;
  const recoveryIndexKey = `${key}:conflict-backup:v1:latest`;
  let current: CacheEnvelope | null = null;
  let status: AccountStoreStatus = {
    loaded: false,
    offline: false,
    dirty: false,
    revision: 0,
    migration: "none",
    message: "Opening your account…",
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = (accountQueues.get(key) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => undefined);
    accountQueues.set(key, settled);
    void settled.finally(() => {
      if (accountQueues.get(key) === settled) accountQueues.delete(key);
    });
    return next;
  };
  function parseCache(raw: string | null): CacheEnvelope | null {
    if (raw === null) return null;
    let value: CacheEnvelope;
    try {
      value = JSON.parse(raw) as CacheEnvelope;
    } catch {
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "This account’s local cache could not be read. It has been retained.",
      );
    }
    if (
      !value ||
      value.version !== 1 ||
      value.ownerId !== userId ||
      typeof value.payload !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.dirty !== "boolean" ||
      value.verifiedOnline !== true ||
      (value.migrationDigest !== undefined &&
        !digestValid(value.migrationDigest))
    )
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "This account’s cache identity or revision is invalid. It has been retained.",
      );
    parseBackup(value.payload);
    return value;
  }
  async function readCache(): Promise<CacheEnvelope | null> {
    return parseCache(await cache.getItem(key));
  }
  async function writeCache(value: CacheEnvelope): Promise<void> {
    try {
      await cache.setItem(key, JSON.stringify(value));
    } catch {
      throw new AccountStoreError(
        "CACHE_ERROR",
        "Your changes could not be saved on this device. Existing records have been retained.",
      );
    }
    current = value;
    status = {
      ...status,
      loaded: true,
      dirty: value.dirty,
      revision: value.revision,
    };
  }
  function envelope(
    payload: string,
    revision: number,
    dirty = false,
    migrationDigest?: string,
  ): CacheEnvelope {
    parseBackup(payload);
    return {
      version: 1,
      ownerId: userId,
      payload,
      revision,
      dirty,
      verifiedOnline: true,
      ...(migrationDigest ? { migrationDigest } : {}),
    };
  }
  async function saveRemote(payload: string, revision: number) {
    const saved = validateRemote(await remote.save(payload, revision));
    if (
      saved.payload === null ||
      saved.revision !== revision + 1 ||
      !sameSnapshot(saved.payload, payload)
    )
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "The saved account data did not match your changes. Your local copy has been retained.",
      );
    return saved as { payload: string; revision: number };
  }
  async function retainLegacyBackup(payload: string, digest: string) {
    const previous = await cache.getItem(backupKey);
    if (previous !== null) {
      let backup: LegacyBackup;
      try {
        backup = JSON.parse(previous) as LegacyBackup;
      } catch {
        throw new AccountStoreError(
          "CORRUPT_DATA",
          "The existing migration backup could not be read. It has been retained.",
        );
      }
      if (
        backup?.version !== 1 ||
        backup.ownerId !== userId ||
        backup.digest !== digest ||
        backup.payload !== payload
      )
        throw new AccountStoreError(
          "CONFLICT",
          "A different migration backup already exists. Both the backup and original records have been retained.",
        );
      return;
    }
    await cache.setItem(
      backupKey,
      JSON.stringify({
        version: 1,
        ownerId: userId,
        payload,
        digest,
      } satisfies LegacyBackup),
    );
  }
  async function readMigrationStatus(): Promise<MigrationStatus> {
    const migration = await remote.migrationStatus();
    if (
      !migration ||
      typeof migration.eligible !== "boolean" ||
      typeof migration.completed !== "boolean" ||
      (migration.digest !== undefined && !digestValid(migration.digest))
    )
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "The migration eligibility response is invalid.",
      );
    return {
      eligible: migration.eligible,
      completed: migration.completed,
      ...(migration.digest ? { digest: migration.digest } : {}),
    };
  }
  async function verifyMigrationReceipt(
    cached: CacheEnvelope | null,
    loaded: RemoteSnapshot,
    migration: MigrationStatus,
  ): Promise<string | undefined> {
    let migrationDigest = cached?.migrationDigest;
    if (
      migration.completed &&
      migration.digest &&
      migrationDigest &&
      migration.digest !== migrationDigest
    )
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "This device’s migration receipt does not match the server. Existing records have been retained.",
      );
    if (
      migration.completed &&
      migration.digest === migrationDigest &&
      migrationDigest
    )
      status = { ...status, migration: "verified" };
    // If the migration response was lost, verify the retained backup against
    // the persisted original before creating this device's verification receipt.
    if (migration.completed && migration.digest && !migrationDigest) {
      const rawBackup = await cache.getItem(backupKey);
      if (rawBackup !== null) {
        let backup: LegacyBackup;
        try {
          backup = JSON.parse(rawBackup) as LegacyBackup;
        } catch {
          throw new AccountStoreError(
            "CORRUPT_DATA",
            "The retained migration backup could not be read. It has been retained.",
          );
        }
        if (
          backup?.version !== 1 ||
          backup.ownerId !== userId ||
          backup.digest !== migration.digest ||
          typeof backup.payload !== "string" ||
          (await hash(backup.payload)) !== migration.digest
        )
          throw new AccountStoreError(
            "CORRUPT_DATA",
            "The retained migration backup does not match the server receipt. Original records have been retained.",
          );
        parseBackup(backup.payload);
        if (
          loaded.payload !== null &&
          (await hash(loaded.payload)) === migration.digest &&
          sameSnapshot(loaded.payload, backup.payload)
        ) {
          migrationDigest = migration.digest;
          status = { ...status, migration: "verified" };
        } else if (loaded.revision <= 1) {
          throw new AccountStoreError(
            "CORRUPT_DATA",
            "The persisted migration records do not match the original backup. Migration has not been marked verified on this device.",
          );
        }
        // A later revision may contain real edits: do not replace or reimport it.
      }
    }
    return migrationDigest;
  }
  const conflictReviews = new Map<
    string,
    {
      review: string;
      signature: string;
      records: { device: string; account: string };
    }
  >();
  const staleReview = () =>
    new AccountStoreError(
      "CONFLICT",
      "The reviewed versions have changed or this review belongs to another account. Review both versions again. Your pending changes and account records have been retained.",
    );
  async function checkedHash(value: string): Promise<string> {
    const digest = await hash(value);
    if (!digestValid(digest))
      throw new AccountStoreError(
        "CORRUPT_DATA",
        "The recovery copy could not be verified. Both original versions have been retained.",
      );
    return digest;
  }
  async function readConflictContext() {
    const cachedRaw = await cache.getItem(key);
    const cached = parseCache(cachedRaw);
    // These calls use the same authenticated backend gates as normal loading.
    const migration = await readMigrationStatus();
    const loaded = validateRemote(await remote.load());
    if (cached && loaded.revision < cached.revision)
      throw new AccountStoreError(
        "CONFLICT",
        "Previously saved account records are missing or older on the server. Your device copy and any pending changes have been retained. Reconnect or contact support before saving again.",
      );
    const migrationDigest = await verifyMigrationReceipt(
      cached,
      loaded,
      migration,
    );
    if ((await cache.getItem(key)) !== cachedRaw) throw staleReview();
    if (migration.eligible && !migration.completed)
      throw new AccountStoreError(
        "MIGRATION_REQUIRED",
        "This account's original planner must finish migration before conflict recovery. Existing records and backups have been retained.",
      );
    if (
      cachedRaw === null ||
      !cached?.dirty ||
      loaded.payload === null ||
      loaded.revision <= cached.revision ||
      sameSnapshot(loaded.payload, cached.payload)
    )
      throw staleReview();
    const account = { payload: loaded.payload, revision: loaded.revision };
    return {
      cached,
      cachedRaw,
      account,
      migrationDigest,
      signature: JSON.stringify({
        ownerId: userId,
        deviceCache: cachedRaw,
        account,
        migration,
      }),
    };
  }
  function snapshotSummary(
    payload: string,
    revision: number,
  ): AccountSnapshotSummary {
    const state = parseBackup(payload);
    return {
      revision,
      rotaEntries: state.entries.length,
      tasks: state.tasks.length,
      sleepLogs: state.sleepLogs.length,
      onboardingComplete: state.settings.onboardingComplete,
    };
  }
  async function reviewConflict(): Promise<AccountConflictReview> {
    return serial(async () => {
      const context = await readConflictContext();
      const token = await checkedHash(context.signature);
      const makeRecord = async (
        source: "device" | "account",
        payload: string,
        revision: number,
      ) => {
        const record: AccountConflictRecoveryRecord = {
          version: 1,
          ownerId: userId,
          source,
          reviewToken: token,
          revision,
          payload,
          payloadDigest: await checkedHash(payload),
          ...(source === "device" ? { deviceCache: context.cachedRaw } : {}),
        };
        const text = JSON.stringify(record);
        return {
          text,
          key: `${key}:conflict-backup:v1:${source}:${await checkedHash(text)}`,
        };
      };
      const device = await makeRecord(
        "device",
        context.cached.payload,
        context.cached.revision,
      );
      const account = await makeRecord(
        "account",
        context.account.payload,
        context.account.revision,
      );
      const review: AccountConflictReview = {
        ownerId: userId,
        token,
        device: {
          payload: context.cached.payload,
          summary: snapshotSummary(
            context.cached.payload,
            context.cached.revision,
          ),
        },
        account: {
          payload: context.account.payload,
          summary: snapshotSummary(
            context.account.payload,
            context.account.revision,
          ),
        },
        recoveryKeys: { device: device.key, account: account.key },
      };
      conflictReviews.set(token, {
        review: JSON.stringify(review),
        signature: context.signature,
        records: { device: device.text, account: account.text },
      });
      return review;
    });
  }
  async function preserveRecoveryRecord(
    recoveryKey: string,
    text: string,
  ): Promise<void> {
    try {
      const previous = await cache.getItem(recoveryKey);
      if (previous !== null && previous !== text)
        throw new Error("Recovery copy address is already occupied");
      if (previous === null) await cache.setItem(recoveryKey, text);
      if ((await cache.getItem(recoveryKey)) !== text)
        throw new Error("Recovery copy read-back did not match");
    } catch {
      throw new AccountStoreError(
        "CACHE_ERROR",
        "Both recovery copies could not be preserved and verified on this device. The active device version and account records have been retained.",
      );
    }
  }
  async function preserveRecoveryIndex(review: AccountConflictReview) {
    const text = JSON.stringify({
      version: 1,
      ownerId: userId,
      reviewToken: review.token,
      recoveryKeys: review.recoveryKeys,
    });
    try {
      await cache.setItem(recoveryIndexKey, text);
      if ((await cache.getItem(recoveryIndexKey)) !== text)
        throw new Error("Recovery index read-back did not match");
    } catch {
      throw new AccountStoreError(
        "CACHE_ERROR",
        "The recovery copies could not be indexed and verified. The active device version and account records have been retained.",
      );
    }
  }
  async function readConflictRecovery(): Promise<AccountConflictRecovery | null> {
    return serial(async () => {
      const raw = await cache.getItem(recoveryIndexKey);
      if (raw === null) return null;
      const invalid = () =>
        new AccountStoreError(
          "CORRUPT_DATA",
          "The retained recovery copies could not be verified for this account. Existing records have been retained.",
        );
      let index: {
        version: number;
        ownerId: string;
        reviewToken: string;
        recoveryKeys: { device: string; account: string };
      };
      try {
        index = JSON.parse(raw);
      } catch {
        throw invalid();
      }
      if (
        index?.version !== 1 ||
        index.ownerId !== userId ||
        !digestValid(index.reviewToken) ||
        typeof index.recoveryKeys?.device !== "string" ||
        typeof index.recoveryKeys?.account !== "string"
      )
        throw invalid();
      const readRecord = async (source: "device" | "account") => {
        const recoveryKey = index.recoveryKeys[source];
        if (!recoveryKey.startsWith(`${key}:conflict-backup:v1:${source}:`))
          throw invalid();
        const recordRaw = await cache.getItem(recoveryKey);
        if (recordRaw === null) throw invalid();
        let record: AccountConflictRecoveryRecord;
        try {
          record = JSON.parse(recordRaw);
        } catch {
          throw invalid();
        }
        if (
          record?.version !== 1 ||
          record.ownerId !== userId ||
          record.source !== source ||
          record.reviewToken !== index.reviewToken ||
          !Number.isSafeInteger(record.revision) ||
          record.revision < 0 ||
          typeof record.payload !== "string" ||
          record.payloadDigest !== (await checkedHash(record.payload)) ||
          recoveryKey !==
            `${key}:conflict-backup:v1:${source}:${await checkedHash(recordRaw)}`
        )
          throw invalid();
        if (source === "device") {
          if (typeof record.deviceCache !== "string") throw invalid();
          const original = parseCache(record.deviceCache);
          if (
            !original?.dirty ||
            original.payload !== record.payload ||
            original.revision !== record.revision
          )
            throw invalid();
        } else if (record.deviceCache !== undefined) throw invalid();
        return {
          payload: record.payload,
          summary: snapshotSummary(record.payload, record.revision),
        };
      };
      const device = await readRecord("device");
      const account = await readRecord("account");
      return {
        ownerId: userId,
        device,
        account,
        recoveryKeys: { ...index.recoveryKeys },
      };
    });
  }
  async function resolveConflictWithAccount(
    review: AccountConflictReview,
  ): Promise<AppState> {
    return serial(async () => {
      const issued = review && conflictReviews.get(review.token);
      if (
        !issued ||
        review.ownerId !== userId ||
        issued.review !== JSON.stringify(review)
      )
        throw staleReview();
      let context = await readConflictContext();
      if (issued.signature !== context.signature) throw staleReview();
      await preserveRecoveryRecord(
        review.recoveryKeys.device,
        issued.records.device,
      );
      await preserveRecoveryRecord(
        review.recoveryKeys.account,
        issued.records.account,
      );
      await preserveRecoveryIndex(review);
      // Recheck after the asynchronous backup writes; another device may have
      // saved, or this browser may have edited its pending copy while awaiting I/O.
      context = await readConflictContext();
      if (
        issued.signature !== context.signature ||
        (await cache.getItem(key)) !== context.cachedRaw
      )
        throw staleReview();
      await writeCache(
        envelope(
          context.account.payload,
          context.account.revision,
          false,
          context.migrationDigest,
        ),
      );
      conflictReviews.delete(review.token);
      status = {
        ...status,
        offline: false,
        message:
          "The saved account version is open. Both original versions were preserved in recovery copies on this device.",
      };
      return parseBackup(context.account.payload);
    });
  }
  async function loadState(): Promise<AppState> {
    return serial(async () => {
      const cached = await readCache();
      try {
        // Never inspect/import legacy information without a trusted backend grant.
        const migration = await readMigrationStatus();
        status = {
          ...status,
          migration: migration.completed
            ? "completed"
            : migration.eligible
              ? "eligible"
              : "none",
        };
        let loaded = validateRemote(await remote.load());
        if (cached && loaded.revision < cached.revision)
          throw new AccountStoreError(
            "CONFLICT",
            "Previously saved account records are missing or older on the server. Your device copy and any pending changes have been retained. Reconnect or contact support before saving again.",
          );
        let migrationDigest = await verifyMigrationReceipt(
          cached,
          loaded,
          migration,
        );
        if (migration.eligible && !migration.completed) {
          const legacy = await readLegacy();
          if (legacy === null)
            throw new AccountStoreError(
              "MIGRATION_REQUIRED",
              "This account needs its original saved planner before it can open. Finish migration in the preserved development app using its original browser or device. Your original records and backup have been retained.",
            );
          if (legacy !== null) {
            parseBackup(legacy);
            if (loaded.payload !== null)
              throw new AccountStoreError(
                "CONFLICT",
                "This account already has saved records. Migration has stopped to preserve them and your original local data.",
              );
            const digest = await hash(legacy);
            if (!digestValid(digest))
              throw new AccountStoreError(
                "CORRUPT_DATA",
                "The migration backup digest could not be verified.",
              );
            await retainLegacyBackup(legacy, digest);
            const migrated = await remote.migrate(legacy, digest);
            validateRemote(migrated);
            if (
              !digestValid(migrated.digest) ||
              migrated.digest !== digest ||
              migrated.payload === null ||
              (await hash(migrated.payload)) !== digest ||
              !sameSnapshot(migrated.payload, legacy)
            )
              throw new AccountStoreError(
                "CORRUPT_DATA",
                "Migration verification failed. The backup and original records have been retained; migration has not been marked verified on this device.",
              );
            loaded = migrated;
            migrationDigest = digest;
            status = { ...status, migration: "verified" };
          }
        }
        if (cached?.dirty) {
          if (loaded.revision !== cached.revision) {
            // A response may have been lost after a successful previous save.
            if (
              loaded.payload === null ||
              !sameSnapshot(loaded.payload, cached.payload)
            )
              throw new AccountStoreError(
                "CONFLICT",
                "Your account has newer saved records elsewhere. Your pending local changes have been retained. Reconnect and resolve the conflict before saving.",
              );
          } else {
            loaded = await saveRemote(cached.payload, cached.revision);
          }
        }
        const payload = loaded.payload ?? JSON.stringify(initialState());
        await writeCache(
          envelope(payload, loaded.revision, false, migrationDigest),
        );
        status = {
          ...status,
          offline: false,
          message: "Account data is up to date.",
        };
        return parseBackup(payload);
      } catch (error) {
        if (!networkFailure(error) || cached === null) {
          status = {
            ...status,
            loaded: false,
            offline: false,
            message:
              error instanceof Error
                ? error.message
                : "Account data could not be loaded. Existing records have been retained.",
          };
          throw error;
        }
        current = cached;
        status = {
          ...status,
          loaded: true,
          offline: true,
          dirty: cached.dirty,
          revision: cached.revision,
          migration: cached.migrationDigest ? "verified" : status.migration,
          message: cached.dirty
            ? "Offline: your changes are saved on this device and await synchronisation."
            : "Offline: showing only this account’s saved data.",
        };
        return parseBackup(cached.payload);
      }
    });
  }
  function saveState(state: AppState): Promise<void> {
    // Capture the exact revision before waiting behind other account operations.
    const payload = JSON.stringify(state);
    parseBackup(payload);
    return serial(async () => {
      if (!current || !status.loaded)
        throw new AccountStoreError(
          "NOT_LOADED",
          "Account data must be loaded before it can be saved.",
        );
      const pending = envelope(
        payload,
        current.revision,
        true,
        current.migrationDigest,
      );
      status = { ...status, message: "Saving to your account…" };
      await writeCache(pending);
      try {
        const saved = await saveRemote(payload, pending.revision);
        await writeCache(
          envelope(
            saved.payload,
            saved.revision,
            false,
            pending.migrationDigest,
          ),
        );
        status = {
          ...status,
          offline: false,
          message: "Saved to your account and this device.",
        };
      } catch (error) {
        if (!networkFailure(error)) {
          status = {
            ...status,
            offline: false,
            message:
              error instanceof Error
                ? error.message
                : "Account save failed. Your local copy has been retained.",
          };
          throw error;
        }
        status = {
          ...status,
          offline: true,
          message:
            "Offline: your changes are saved on this device and await synchronisation.",
        };
      }
    });
  }
  return {
    loadState,
    saveState,
    reviewConflict,
    resolveConflictWithAccount,
    readConflictRecovery,
    /** Resets only this account through compare-and-swap; legacy backup/data remain. */
    deleteState: () => saveState(initialState()),
    status: (): AccountStoreStatus => ({ ...status }),
  };
}

export type AccountStore = ReturnType<typeof createAccountStore>;
