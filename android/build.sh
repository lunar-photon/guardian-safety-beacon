#!/usr/bin/env bash
# Build the Guardian debug APK locally.
# Needs: JDK 17, an Android SDK (ANDROID_HOME/ANDROID_SDK_ROOT), and Gradle.
# Output: app/build/outputs/apk/debug/app-debug.apk  (install with: adb install -r <apk>)
set -e
cd "$(dirname "$0")"

# --- toolchain checks -------------------------------------------------------
missing=0
command -v java  >/dev/null || { echo "✗ Java not found. Install JDK 17 (e.g. CachyOS/Arch: sudo pacman -S jdk17-openjdk)"; missing=1; }
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
  echo "✗ Android SDK not found. Set ANDROID_HOME to your SDK path."
  echo "  Arch/CachyOS: install 'android-sdk-cmdline-tools-latest' (AUR), then:"
  echo "    export ANDROID_HOME=/opt/android-sdk"
  echo "    sdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0'"
  missing=1
fi
GRADLE=""
if   command -v gradle >/dev/null; then GRADLE="gradle"
elif [ -x ./gradlew ];              then GRADLE="./gradlew"
else echo "✗ Gradle not found. Install it (sudo pacman -S gradle) or run 'gradle wrapper' once."; missing=1; fi
[ "$missing" = 1 ] && { echo; echo "Toolchain incomplete — fix the ✗ items above, or just use the GitHub Actions build (.github/workflows/android.yml)."; exit 1; }

# --- build ------------------------------------------------------------------
echo "Building debug APK with: $GRADLE"
$GRADLE assembleDebug --no-daemon --stacktrace
echo
echo "✓ APK: $(ls -1 app/build/outputs/apk/debug/*.apk 2>/dev/null)"
echo "  Install over USB: adb install -r app/build/outputs/apk/debug/app-debug.apk"
