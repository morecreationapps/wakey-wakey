/** Trusted operator tool. Never import this into the app or run it in browser code. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the trusted operator environment.`);
  return value;
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

async function main() {
  if (process.env.ADMIN_SETUP_ACK !== "reviewed-account-and-backup")
    throw new Error("Set ADMIN_SETUP_ACK=reviewed-account-and-backup after reviewing the target account and backup.");
  const action = required("ADMIN_SETUP_ACTION");
  if (!["reserve", "bind"].includes(action)) throw new Error("ADMIN_SETUP_ACTION must be reserve or bind.");
  const email = required("ADMIN_EMAIL").trim().toLowerCase();
  const userId = action === "bind" ? required("ADMIN_USER_ID") : null;
  const backupPath = required("ADMIN_BACKUP_FILE");
  const expectedDigest = required("ADMIN_BACKUP_SHA256");
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email))
    throw new Error("ADMIN_EMAIL must be the explicitly approved administrator email.");
  if (userId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
    throw new Error("ADMIN_USER_ID must be the verified account UUID from Supabase Auth.");
  if (!/^[a-f0-9]{64}$/.test(expectedDigest))
    throw new Error("ADMIN_BACKUP_SHA256 must be the recorded digest of the exact recovered snapshot.");
  const backup = await readFile(backupPath);
  if (backup.length > 10_000_000) throw new Error("The recovered snapshot exceeds the supported 10 MB limit.");
  const actualDigest = createHash("sha256").update(backup).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error("Backup digest mismatch. No server changes were made.");
  let snapshot;
  try { snapshot = JSON.parse(backup.toString("utf8")); }
  catch { throw new Error("The recovered snapshot is not JSON. No server changes were made."); }
  if (snapshot?.schemaVersion !== 1 || !snapshot.settings ||
    ["entries", "templates", "patterns", "tasks", "sleepLogs"].some((key) => !Array.isArray(snapshot[key])))
    throw new Error("The recovered snapshot has an unexpected schema. No server changes were made.");

  const connection = new URL(required("SUPABASE_DB_URL"));
  if (!["postgres:", "postgresql:"].includes(connection.protocol)) throw new Error("A PostgreSQL database URL is required.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname);
  const sslMode = connection.searchParams.get("sslmode") ?? (local ? "disable" : "require");
  if (!local && !["require", "verify-ca", "verify-full"].includes(sslMode))
    throw new Error("A remote database connection must require TLS.");
  // The credential is supplied to libpq via environment, never a command-line argument.
  const env = {
    ...process.env,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1) || "postgres"),
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: sslMode,
    PGCONNECT_TIMEOUT: "15",
  };
  delete env.SUPABASE_DB_URL;
  const statement = action === "reserve"
    ? `private.reserve_admin_migration(${quote(email)}, ${quote(actualDigest)})`
    : `private.prepare_admin_migration(${quote(userId)}::uuid, ${quote(email)}, ${quote(actualDigest)})`;
  const sql = `begin; select ${statement}; commit;`;
  const child = spawn(process.env.PSQL_BIN || "psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(sql);
  const code = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not run psql. Install the PostgreSQL client or set PSQL_BIN on the trusted operator machine.")));
    child.once("close", resolve);
  });
  if (code !== 0) {
    // SQL exceptions can contain addresses and connection errors; emit only the reviewed reason.
    const known = [
      "The approved account must already own a verified email and password.",
      "A different backup is already bound to this account.",
      "This account already has saved settings; migration refused.",
      "Invalid trusted backup digest.",
      "A different backup is already reserved for this email.",
      "A matching trusted reservation is required before binding.",
    ].find((reason) => stderr.includes(reason));
    throw new Error(known || "Trusted server setup failed. Check the database connection and server logs privately; no credentials are printed here.");
  }
  let receipt;
  try { receipt = JSON.parse(output.trim()); }
  catch { throw new Error("Server setup returned an unexpected receipt. Verify server state privately before retrying."); }
  if ((action === "bind" && receipt.user_id !== userId) || receipt.digest !== actualDigest)
    throw new Error("The server receipt does not match the approved account and backup.");
  console.log(JSON.stringify({ action, userId, backupDigest: actualDigest, alreadyCompleted: receipt.completed ?? false,
    message: action === "reserve" ? "Legacy settings reserved before signup. No administrator role was granted."
      : "Trusted migration grant prepared. No password was set and no app settings were uploaded by this tool." }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
