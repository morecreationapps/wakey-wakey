import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
// One dashboard-deployable file uses exactly the web/native planner engine.
await mkdir("supabase/functions/wakey-reminders/deploy", { recursive: true });
await build({
  entryPoints: ["supabase/functions/wakey-reminders/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  minify: true,
  external: ["npm:*"],
  alias: { "@js-temporal/polyfill": "npm:@js-temporal/polyfill@0.5.1" },
  outfile: "supabase/functions/wakey-reminders/deploy/index.ts",
});
