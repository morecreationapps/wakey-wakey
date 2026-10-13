import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  createAccountDeletionHandler,
  deletionIdentityFromVerifiedClaims,
} from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const server = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createAccountDeletionHandler({
    now: () => Date.now(),
    async identity(token) {
      const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const userResult = await client.auth.getUser(token);
      const user = userResult.data.user;
      if (userResult.error || !user?.email_confirmed_at || user.is_anonymous)
        return null;
      const verified = await client.auth.getClaims(token);
      const claims = verified.data?.claims;
      if (verified.error || !claims) return null;
      const identity = deletionIdentityFromVerifiedClaims(
        user,
        claims,
        Date.now(),
      );
      if (!identity) return null;
      // This checks current session/user records and recent signed password AMR.
      // It does not require a planner snapshot or an administrator migration.
      const permission = await client.rpc("planner_assert_account_deletion");
      if (permission.error || permission.data !== true) return null;
      return identity;
    },
    async revokeSessions(token) {
      const { error } = await server.auth.admin.signOut(token, "global");
      if (error) throw new Error("Session revocation failed.");
    },
    async hardDelete(userId) {
      const { error } = await server.auth.admin.deleteUser(userId, false);
      if (error) throw new Error("Account deletion failed.");
    },
  }),
);
