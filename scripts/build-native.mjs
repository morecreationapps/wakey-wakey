import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { checkPublicSource } from "./check-public-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { expo: appConfig } = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
const version = appConfig.version;
const buildNumber = appConfig.ios.buildNumber;
const target = process.argv[2];
if (!["ios", "macos", "simulator", "android"].includes(target)) {
  throw new Error("Choose ios, macos, simulator or android.");
}
const output = resolve(process.argv[3] ?? "/private/tmp/wakey-native-release");
mkdirSync(output, { recursive: true });
checkPublicSource(root);

// Native and Pages clients must use the same public backend configuration.
// These are public frontend values, never service-role or signing credentials.
const workflow = readFileSync(
  join(root, ".github/workflows/pages.yml"),
  "utf8",
);
const env = { ...process.env };
for (const name of [
  "EXPO_PUBLIC_SUPABASE_URL",
  "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_AUTH_EMAIL_CONFIGURED",
]) {
  const match = workflow.match(new RegExp(`^\\s+${name}: "([^"]+)"$`, "m"));
  if (!match)
    throw new Error(`Missing published frontend configuration: ${name}`);
  env[name] = match[1];
}
if (
  env.EXPO_PUBLIC_SUPABASE_URL !== "https://zhdoydzgtuskiflnzzxh.supabase.co" ||
  !env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_") ||
  env.EXPO_PUBLIC_AUTH_EMAIL_CONFIGURED !== "true"
) {
  throw new Error("Native authentication configuration is incomplete.");
}

let command;
let args;
if (target === "android") {
  // AGP's Prefab CLI treats JDK 25's native-access warning as an error.
  // Use the installed JDK 21 on macOS rather than Android Studio's newer JBR.
  if (process.platform === "darwin") {
    const java = spawnSync("/usr/libexec/java_home", ["-v", "21"], {
      encoding: "utf8",
    });
    if (java.status !== 0)
      throw new Error("Android release builds require JDK 21.");
    env.JAVA_HOME = java.stdout.trim();
    env.ANDROID_HOME ??= join(homedir(), "Library/Android/sdk");
  }
  command = join(root, "android/gradlew");
  args = [
    "-p",
    "android",
    "bundleRelease",
    "--no-daemon",
    "--console=plain",
    "--max-workers=2",
  ];
} else {
  command = "xcodebuild";
  args = [
    "-quiet",
    "-workspace",
    "ios/WakeyWakey.xcworkspace",
    "-scheme",
    "WakeyWakey",
    "-configuration",
    target === "simulator" ? "Debug" : "Release",
    "-destination",
    target === "macos"
      ? "generic/platform=macOS,variant=Mac Catalyst"
      : target === "simulator"
        ? "generic/platform=iOS Simulator"
        : "generic/platform=iOS",
    "-derivedDataPath",
    join(output, `derived-${target}`),
    "-jobs",
    "2",
  ];
  if (target === "simulator") args.push("CODE_SIGNING_ALLOWED=NO", "build");
  else
    args.push(
      "-archivePath",
      join(output, `WakeyWakey-${target}-${version}-${buildNumber}.xcarchive`),
      "-allowProvisioningUpdates",
      ...(target === "macos"
        ? ["MACOSX_DEPLOYMENT_TARGET=13.4", "IPHONEOS_DEPLOYMENT_TARGET=16.4"]
        : []),
      "archive",
    );
}
console.log(
  `Building ${target}; version ${version} (${target === "android" ? appConfig.android.versionCode : buildNumber}), published account service configured.`,
);
const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
checkPublicSource(root);
console.log(
  `${target} native build command completed. Validate the artifact before upload.`,
);
