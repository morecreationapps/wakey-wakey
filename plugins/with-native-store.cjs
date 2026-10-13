const {
  withEntitlementsPlist,
  withPodfile,
  withXcodeProject,
  withDangerousMod,
  withAppBuildGradle,
} = require("expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

/** Native reminders are scheduled locally; no APNs capability is needed. */
module.exports = function withNativeStore(config) {
  config = withAppBuildGradle(config, (mod) => {
    // Local release checks remain unsigned until a store upload key is supplied.
    mod.modResults.contents = mod.modResults.contents.replace(
      /release \{\s*\/\/ Caution![\s\S]*?signingConfig signingConfigs\.debug/,
      "release {\n            signingConfig null",
    );
    return mod;
  });
  config = withEntitlementsPlist(config, (mod) => {
    delete mod.modResults["aps-environment"];
    return mod;
  });
  config = withPodfile(config, (mod) => {
    mod.modResults.contents = mod.modResults.contents.replace(
      ":mac_catalyst_enabled => false",
      ":mac_catalyst_enabled => true",
    );
    if (!mod.modResults.contents.includes("# Wakey-Wakey Catalyst minimum")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /(react_native_post_install\([\s\S]*?\n    \))\n/,
        `$1
    # Wakey-Wakey Catalyst minimum: Xcode 27 no longer supports macOS 10.15.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |configuration|
        configuration.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '13.4'
        configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'
      end
    end
`,
      );
    }
    return mod;
  });
  config = withXcodeProject(config, (mod) => {
    const configurations = mod.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(configurations)) {
      if (!entry?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER) continue;
      const settings = entry.buildSettings;
      settings.SUPPORTS_MACCATALYST = "YES";
      settings.DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER = "NO";
      settings.MACOSX_DEPLOYMENT_TARGET = "13.4";
      settings['"CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"'] =
        '"WakeyWakey/WakeyWakey-mac.entitlements"';
      settings['"ENABLE_HARDENED_RUNTIME[sdk=macosx*]"'] = "YES";
    }
    const project = mod.modResults;
    const name = "[Wakey] Normalize Catalyst frameworks";
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const normalizeScript = `if [ "$EFFECTIVE_PLATFORM_NAME" = "-maccatalyst" ]; then\n  if [ -f "$SRCROOT/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi\n  "$NODE_BINARY" "$SRCROOT/../scripts/normalize-catalyst-frameworks.mjs" "$PODS_ROOT"\n  "$NODE_BINARY" "$SRCROOT/../scripts/normalize-catalyst-frameworks.mjs" "$PODS_XCFRAMEWORKS_BUILD_DIR" --xcframework-intermediates\nfi`;
    const existing = Object.values(phases).find((entry) => entry?.name?.includes(name));
    if (existing) {
      existing.shellScript = JSON.stringify(normalizeScript);
    } else {
      project.addBuildPhase(
        [],
        "PBXShellScriptBuildPhase",
        name,
        project.getFirstTarget().uuid,
        {
          shellPath: "/bin/sh",
          shellScript: normalizeScript,
        },
      );
    }
    return mod;
  });
  return withDangerousMod(config, [
    "ios",
    async (mod) => {
      await fs.writeFile(
        path.join(
          mod.modRequest.platformProjectRoot,
          "WakeyWakey",
          "WakeyWakey-mac.entitlements",
        ),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
</dict></plist>
`,
      );
      return mod;
    },
  ]);
};
