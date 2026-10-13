import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, basename } from "node:path";

/** Repair flattened aliases in RN's versioned Catalyst framework tarballs. */
export function normalizeVersionedFramework(framework) {
  const versions = join(framework, "Versions");
  if (!existsSync(versions)) return false;
  const current = join(versions, "Current");
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
    const version = readdirSync(versions).find((name) => name !== "Current");
    if (!version)
      throw new Error("A flattened framework has no named version.");
    cpSync(current, join(versions, version), { recursive: true, force: true });
    rmSync(current, { recursive: true });
    symlinkSync(version, current);
  } else if (!existsSync(current)) {
    const version = readdirSync(versions).find((name) => name !== "Current");
    if (!version)
      throw new Error("A versioned framework has no current version.");
    symlinkSync(version, current);
  }
  const version = readlinkSync(current);
  const directory = join(versions, version);
  const executable = basename(framework, ".framework");
  const binary = join(framework, executable);
  if (existsSync(binary) && !lstatSync(binary).isSymbolicLink()) {
    copyFileSync(binary, join(directory, executable));
    rmSync(binary);
    symlinkSync(`Versions/Current/${executable}`, binary);
  }
  for (const name of ["Resources", "Headers", "Modules"]) {
    const alias = join(framework, name);
    if (!existsSync(alias) || lstatSync(alias).isSymbolicLink()) continue;
    cpSync(alias, join(directory, name), { recursive: true, force: true });
    rmSync(alias, { recursive: true });
    symlinkSync(`Versions/Current/${name}`, alias);
  }
  const resources = join(directory, "Resources");
  mkdirSync(resources, { recursive: true });
  for (const name of readdirSync(framework).filter((name) =>
    name.endsWith(".bundle"),
  )) {
    const alias = join(framework, name);
    if (!lstatSync(alias).isSymbolicLink()) {
      cpSync(alias, join(resources, name), { recursive: true, force: true });
    }
    // macOS seals resource bundles inside Resources, not as root aliases.
    rmSync(alias, { recursive: true });
  }
  return true;
}

const root = process.argv[2];
if (!root)
  throw new Error("Specify the CocoaPods or app Frameworks directory.");
const frameworks =
  process.argv[3] === "--app-frameworks"
    ? readdirSync(root)
        .filter((name) => name.endsWith(".framework"))
        .map((name) => join(root, name))
    : process.argv[3] === "--xcframework-intermediates"
      ? [
          join(root, "React-Core-prebuilt/React.framework"),
          join(root, "ReactNativeDependencies/ReactNativeDependencies.framework"),
        ]
      : [
        join(
          root,
          "React-Core-prebuilt/React.xcframework/ios-arm64_x86_64-maccatalyst/React.framework",
        ),
        join(
          root,
          "ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/ios-arm64_x86_64-maccatalyst/ReactNativeDependencies.framework",
        ),
      ];
for (const framework of frameworks) {
  if (existsSync(framework) && normalizeVersionedFramework(framework)) {
    console.log(`Validated versioned framework layout: ${basename(framework)}`);
  }
}
