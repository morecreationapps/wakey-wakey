import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("supabase/functions/wakey-delete-account/deploy", {
  recursive: true,
});
await build({
  entryPoints: ["supabase/functions/wakey-delete-account/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  minify: true,
  external: ["npm:*"],
  outfile: "supabase/functions/wakey-delete-account/deploy/index.ts",
});
