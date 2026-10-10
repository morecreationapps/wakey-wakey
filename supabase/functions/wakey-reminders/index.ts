import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import webpush from "npm:web-push@3.6.7";
import { createReminderHandler } from "./handler.ts";
const url = Deno.env.get("SUPABASE_URL")!;
const server = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createReminderHandler({
    now: () => Date.now(),
    async identity(token) {
      const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const {
        data: { user },
        error,
      } = await client.auth.getUser(token);
      if (error || !user?.email_confirmed_at || user.is_anonymous) return null;
      // This database RPC additionally checks signed password AMR, expiry, banned
      // users, active Auth session and the trusted account migration guard.
      const verified = await client.rpc("planner_load");
      if (verified.error) return null;
      const claims = JSON.parse(
        atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      return { id: user.id, sessionId: claims.session_id };
    },
    async service(action, data = {}) {
      const result = await server.rpc("wakey_reminder_service", {
        p_action: action,
        p_data: data,
      });
      if (result.error)
        throw new Error("Protected notification storage failed.");
      return result.data;
    },
    generateKeys: () => webpush.generateVAPIDKeys(),
    async digest(value) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    },
    async push(subscription, payload, config) {
      await webpush.sendNotification(subscription, payload, {
        TTL: 90,
        urgency: "high",
        timeout: 8000,
        vapidDetails: {
          subject: "mailto:support@morecreationapps.com",
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      });
    },
  }),
);
