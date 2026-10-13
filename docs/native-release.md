# Native release preparation

Wakey-Wakey! uses one Expo/React Native source for iPhone, iPad and Android. The iPad target also enables Mac Catalyst. Catalyst is a real native UIKit/RN build and requires its own successful archive, export and Mac verification before the macOS listing can be submitted.

## Build identity

- App name: Wakey-Wakey!
- Version: 1.0.0
- iOS build number / Android version code: 1
- Bundle/package ID: `com.morecreationapps.wakeywakey`
- Apple team: `B87H989596`
- App Store Connect app: `6822097517`

`app.json`, `eas.json` and `plugins/with-native-store.cjs` configure these values. Native folders are generated from this configuration and remain ignored in Git.

## Native generation

Install the locked JavaScript dependencies, then run:

```sh
npx expo prebuild --no-install
cd ios
pod install
```

Xcode 27 needs Expo 57's UIKit scene lifecycle; `expo-build-properties` enables it. Expo modules build from source to allow the Catalyst target. Native reminders are local notifications; the configuration removes the unnecessary APNs entitlement and does not request Face ID.

The app's own privacy manifest declarations are in `ios.privacyManifests`. CocoaPods aggregates required-reason API manifests from the native SDKs. App Store privacy answers and the public privacy policy must describe the final shipped data flows separately.

## iPhone and iPad checks

```sh
xcodebuild -workspace ios/WakeyWakey.xcworkspace -scheme WakeyWakey \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /private/tmp/wakey-native-derived CODE_SIGNING_ALLOWED=NO build
```

A simulator build is for testing and screenshots; it cannot be uploaded to App Store Connect.

## Apple store archives

Use Xcode's signed Apple account for team `B87H989596`, with the correct Wakey-Wakey provisioning profile. The wrapper loads the same public authentication configuration as the deployed Pages app and refuses incomplete configuration. Keep intermediates in local temporary storage, then copy only finished artifacts into the workspace. Run Apple builds sequentially because RN/Expo scripts replace shared framework caches by configuration.

```sh
node scripts/build-native.mjs ios /private/tmp/wakey-native-release
node scripts/build-native.mjs macos /private/tmp/wakey-native-release
```

Export through Xcode using App Store Connect distribution. Confirm the signature, bundle ID, version, privacy manifest and embedded release JS bundle. An archive/export is separate from upload, processing, build selection, review submission and release.

Mac Catalyst uses the same bundle ID for the existing App Store Connect record. Mac-only entitlements enable App Sandbox, outgoing connections, and user-selected file read/write access. This supports account sync and explicit import/export while avoiding broad file access.

RN's prebuilt Catalyst framework tarballs contain flattened aliases alongside their versioned directories. The native configuration adds a pre-embed normalization phase to restore Apple's versioned framework layout while preserving the binary bytes and placing resource bundles inside Resources. The completed local test app's ad hoc signature passed `codesign --verify --deep --strict` after this repair. A fresh generated project and signed store archive still need verification.

## Android store bundle

```sh
node scripts/build-native.mjs android /private/tmp/wakey-native-release
```

Local release builds are intentionally unsigned until a store upload key is supplied. The Expo template's debug signing is removed from Release to prevent a debug-key bundle being mistaken for a production upload. `eas.json` provides a production app-bundle profile for a future configured EAS project. No credentials belong in Git.

The wrapper uses the installed JDK 21 on macOS. Android Studio's current JBR 25 triggers an AGP Prefab native-access warning treated as a build failure. Android builds are limited to two Gradle workers; Apple builds use two jobs to keep the host responsive.

## Release gates

A successful JavaScript export does not verify native installation. Complete native login, onboarding, calendar, task, diary-consent, account-deletion and alert checks on physical devices. Ordinary notifications are not guaranteed alarm delivery. Review screenshots with synthetic data; never include a user's private planner or credentials. Keep screenshot fixtures outside the production checkout and release entry point.
