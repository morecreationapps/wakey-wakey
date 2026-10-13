export interface DeletionIdentity {
  id: string;
  passwordAuthenticatedAt: number;
}
export interface DeletionDependencies {
  now(): number;
  identity(token: string): Promise<DeletionIdentity | null>;
  revokeSessions(token: string): Promise<void>;
  hardDelete(userId: string): Promise<void>;
}
const ORIGIN = "https://morecreationapps.github.io";
export const RECENT_PASSWORD_SECONDS = 300;

/** Call only after Auth.getUser and cryptographic Auth.getClaims succeed. */
export function deletionIdentityFromVerifiedClaims(
  user: { id: string; email_confirmed_at?: string; is_anonymous?: boolean },
  claims: Record<string, unknown>,
  now: number,
): DeletionIdentity | null {
  const amr = claims.amr;
  if (
    !user.email_confirmed_at ||
    user.is_anonymous ||
    claims.sub !== user.id ||
    claims.role !== "authenticated" ||
    claims.client_id ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= now ||
    !Array.isArray(amr) ||
    !amr.length ||
    !amr.every(
      (item) =>
        item &&
        typeof item === "object" &&
        item.method === "password" &&
        typeof item.timestamp === "number" &&
        Number.isFinite(item.timestamp),
    )
  )
    return null;
  return {
    id: user.id,
    passwordAuthenticatedAt: Math.max(
      ...amr.map((item) => item.timestamp as number),
    ),
  };
}

/** A caller cannot supply a target account. Identity comes only from Auth. */
export function createAccountDeletionHandler(deps: DeletionDependencies) {
  return async (req: Request): Promise<Response> => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      Vary: "Origin",
    };
    const response = (value: object, status = 200) =>
      new Response(JSON.stringify(value), { status, headers });
    const origin = req.headers.get("origin");
    if (origin && origin !== ORIGIN)
      return response({ error: "This request origin is not allowed." }, 403);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return response({ error: "Use POST." }, 405);
    try {
      const text = await req.text();
      if (text.length > 1024)
        return response({ error: "Invalid request." }, 400);
      const body = JSON.parse(text) as Record<string, unknown>;
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== "object" ||
        body.confirmation !== "DELETE" ||
        Object.keys(body).some((key) => key !== "confirmation")
      )
        return response({ error: "Confirm permanent account deletion." }, 400);
      const token = req.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/i)?.[1];
      const identity = token ? await deps.identity(token) : null;
      const now = Math.floor(deps.now() / 1000);
      if (
        !identity ||
        !Number.isFinite(identity.passwordAuthenticatedAt) ||
        identity.passwordAuthenticatedAt < now - RECENT_PASSWORD_SECONDS ||
        identity.passwordAuthenticatedAt > now + 30
      )
        return response(
          { error: "Confirm your current password and try again." },
          401,
        );
      // Revoke refresh sessions before deleting; old JWTs are also rejected by
      // every planner/reminder RPC's live auth.users/auth.sessions guard.
      await deps.revokeSessions(token!);
      await deps.hardDelete(identity.id);
      return response({ deleted: true });
    } catch {
      // Never return provider details, tokens, passwords or private rows.
      return response(
        {
          error:
            "Account deletion could not be confirmed. Log in again before retrying.",
        },
        503,
      );
    }
  };
}
