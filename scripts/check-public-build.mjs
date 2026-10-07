import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const PAGES_BASE_PATH = "/wakey-wakey";

/** Reject personal seed data instead of silently modifying a developer's checkout. */
export function checkPublicSource(root = projectRoot) {
  if (existsSync(join(root, "private-inputs"))) {
    throw new Error("Public builds require a clean checkout without private-inputs/.");
  }
  const seedPath = join(root, "src/data/localSeed.ts");
  if (!existsSync(seedPath)) {
    throw new Error("Missing portable seed module. Run pnpm bootstrap first.");
  }
  const seed = readFileSync(seedPath, "utf8");
  const emptySeed = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*export\s+const\s+localRotaText\s*=\s*(?:""|'')\s*;\s*$/;
  if (!emptySeed.test(seed)) {
    throw new Error("Public build blocked: localRotaText must be an empty seed module.");
  }
  const config = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
  if (config.expo?.extra?.publicReleaseReviewed !== false) {
    throw new Error("The public preview must retain publicReleaseReviewed=false.");
  }
}

function outputFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Pages output must not contain symbolic links.");
    return stat.isDirectory() ? outputFiles(path) : [path];
  });
}

/** Verify the artifact has a valid entry point and project-relative bundled assets. */
export function checkPagesOutput(directory) {
  const output = resolve(directory);
  const html = readFileSync(join(output, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  if (scripts.length === 0) throw new Error("Pages output has no application script.");
  for (const url of scripts) {
    if (!url.startsWith(`${PAGES_BASE_PATH}/_expo/`)) {
      throw new Error("Exported script URL does not use the GitHub Pages project path.");
    }
    const path = resolve(output, url.slice(PAGES_BASE_PATH.length + 1).split(/[?#]/)[0]);
    if (relative(output, path).startsWith("..") || !existsSync(path)) {
      throw new Error("An exported script URL does not resolve to an artifact file.");
    }
  }
  const files = outputFiles(output);
  let bundledAssetPath = false;
  for (const path of files) {
    const name = relative(output, path).replaceAll("\\", "/");
    if (/(?:^|\/)(?:private-inputs|localSeed\.ts)(?:\/|$)/.test(name)) {
      throw new Error("Private input files are present in the deployment artifact.");
    }
    if (/\.(?:js|json|html|txt|map)$/.test(name)) {
      const text = readFileSync(path, "utf8");
      if (/\d{2}\/\d{2}\/\d{4}:\s*Duty\s+\w+/i.test(text)) {
        throw new Error("A textual personal rota appears in the deployment artifact.");
      }
      if (name.endsWith(".js") && text.includes(`${PAGES_BASE_PATH}/assets/`)) {
        bundledAssetPath = true;
      }
    }
  }
  if (files.some((path) => relative(output, path).startsWith("assets/")) && !bundledAssetPath) {
    throw new Error("Bundled assets do not use the GitHub Pages project path.");
  }
  if (!existsSync(join(output, ".nojekyll"))) {
    throw new Error("The Pages output is missing its .nojekyll marker.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPublicSource();
  if (process.argv[2]) checkPagesOutput(resolve(projectRoot, process.argv[2]));
  console.log(process.argv[2] ? "Public source and Pages artifact checks passed." : "Public source checks passed.");
}
