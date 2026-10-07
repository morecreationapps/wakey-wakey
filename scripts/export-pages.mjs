import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./bootstrap.mjs";
import { checkPagesOutput, checkPublicSource } from "./check-public-build.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
checkPublicSource(projectRoot);
const result = spawnSync(
  process.execPath,
  [require.resolve("expo/bin/cli"), "export", "--platform", "web", "--clear"],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, WAKEY_DEPLOY_TARGET: "github-pages", EXPO_OFFLINE: "1" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const output = join(projectRoot, "dist");
writeFileSync(join(output, ".nojekyll"), "");
checkPublicSource(projectRoot);
checkPagesOutput(output);
console.log("Public GitHub Pages export and artifact checks passed.");
