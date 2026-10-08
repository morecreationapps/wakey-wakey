import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPagesOutput,
  checkPublicSource,
  outputFiles,
  PAGES_BASE_PATH,
} from "./check-public-build.mjs";
import { prepareWebInstall } from "./web-install.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

/** Pages' archive excludes hidden directories, including Expo's pnpm asset paths. */
export function flattenPagesAssets(directory) {
  const output = resolve(directory);
  const assets = join(output, "assets");
  if (!existsSync(assets)) return 0;
  const replacements = new Map();
  const destinations = new Map();
  for (const file of outputFiles(assets)) {
    const name = basename(file);
    if (name.startsWith("."))
      throw new Error("A generated asset has a hidden filename.");
    const contents = readFileSync(file);
    const previous = destinations.get(name);
    if (previous && !previous.equals(contents)) {
      throw new Error(
        "Generated assets have colliding basenames with different contents.",
      );
    }
    destinations.set(name, contents);
    const original = `${PAGES_BASE_PATH}/${relative(output, file).replaceAll("\\", "/")}`;
    replacements.set(original, `${PAGES_BASE_PATH}/assets/${name}`);
  }
  // Resolve all collisions before writing or removing anything.
  for (const [name, contents] of destinations)
    writeFileSync(join(assets, name), contents);
  const changedBundles = [];
  for (const file of outputFiles(output)) {
    if (!/\.(?:js|json|html|css|map)$/.test(file)) continue;
    const original = readFileSync(file, "utf8");
    let text = original;
    for (const [before, after] of replacements) {
      text = text
        .replaceAll(before, after)
        .replaceAll(encodeURI(before), encodeURI(after));
    }
    if (text !== original) {
      writeFileSync(file, text);
      if (file.endsWith(".js")) changedBundles.push(file);
    }
  }
  for (const name of readdirSync(assets)) {
    const path = join(assets, name);
    if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true });
  }
  // Give modified bundles new URLs so browsers cannot reuse the previous broken export.
  const bundleNames = new Map();
  for (const file of changedBundles) {
    const match = basename(file).match(/^(.*)-[a-f\d]{32}(\.js)$/i);
    if (!match)
      throw new Error("A changed Expo bundle has an unexpected filename.");
    const contents = readFileSync(file);
    const hash = createHash("md5").update(contents).digest("hex");
    const updated = join(dirname(file), `${match[1]}-${hash}${match[2]}`);
    if (file !== updated) {
      if (existsSync(updated))
        throw new Error(
          "The renamed Expo bundle would overwrite another artifact.",
        );
      renameSync(file, updated);
      bundleNames.set(
        relative(output, file).replaceAll("\\", "/"),
        relative(output, updated).replaceAll("\\", "/"),
      );
    }
  }
  for (const file of outputFiles(output)) {
    if (!/\.(?:js|json|html|css|map)$/.test(file)) continue;
    const original = readFileSync(file, "utf8");
    let text = original;
    for (const [before, after] of bundleNames)
      text = text.replaceAll(before, after);
    if (text !== original) writeFileSync(file, text);
  }
  return destinations.size;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await import("./bootstrap.mjs");
  checkPublicSource(projectRoot);
  const result = spawnSync(
    process.execPath,
    [require.resolve("expo/bin/cli"), "export", "--platform", "web", "--clear"],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        WAKEY_DEPLOY_TARGET: "github-pages",
        EXPO_OFFLINE: "1",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const output = join(projectRoot, "dist");
  prepareWebInstall(output, PAGES_BASE_PATH);
  const assets = flattenPagesAssets(output);
  writeFileSync(join(output, ".nojekyll"), "");
  checkPublicSource(projectRoot);
  checkPagesOutput(output);
  console.log(
    `Public GitHub Pages export and artifact checks passed (${assets} flat assets).`,
  );
}
