#!/bin/bash
# Builds Stratus.apk with the same Gradle-free toolchain as Orbit:
# aapt2 (resources) -> javac -> D8 (dex) -> uber-apk-signer (align + debug sign).
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT/ensure_toolchain.sh"

SRC="$ROOT/android"
BUILD="$ROOT/build"
OUT="$ROOT/Stratus.apk"

echo "[0/6] Querying active tunnel and patching telemetry config..."
python3 "$ROOT/../tools/patch_stratus_ngrok.py"

# every build gets a newer version code so it installs over the last one
VERSION_CODE=$(( $(date +%s) - 1700000000 ))
VERSION_NAME="1.0.$VERSION_CODE"

echo "[1/6] Cleaning..."
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/obj" "$BUILD/res" "$BUILD/dex" "$BUILD/dist"

echo "[2/6] Compiling resources..."
"$AAPT2" compile --dir "$SRC/res" -o "$BUILD/res/res.zip"

echo "[3/6] Linking resources..."
"$AAPT2" link -I "$ANDROID_JAR" \
    --manifest "$SRC/AndroidManifest.xml" \
    -o "$BUILD/unaligned.apk" \
    --java "$BUILD/gen" \
    -A "$SRC/assets" \
    --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" --replace-version \
    --auto-add-overlay \
    "$BUILD/res/res.zip"

echo "[4/6] Compiling Java..."
"$JAVAC_BIN" -encoding UTF-8 -Xlint:-options --release 11 \
    -cp "$ANDROID_JAR" -d "$BUILD/obj" \
    $(find "$SRC/src" "$BUILD/gen" -name '*.java')

echo "[5/6] Dexing..."
"$JAVA_BIN" -cp "$R8_JAR" com.android.tools.r8.D8 \
    --lib "$ANDROID_JAR" --release --min-api 26 \
    --output "$BUILD/dex" $(find "$BUILD/obj" -name '*.class')
python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'a') as z:
    z.write(sys.argv[2], 'classes.dex')
" "$BUILD/unaligned.apk" "$BUILD/dex/classes.dex"

echo "[6/6] Aligning and signing..."
"$JAVA_BIN" -jar "$SIGNER_JAR" --apks "$BUILD/unaligned.apk" \
    --out "$BUILD/dist" --allowResign > "$BUILD/sign.log"
SIGNED=$(find "$BUILD/dist" -name '*.apk' | head -n 1)
[ -f "$SIGNED" ] || { cat "$BUILD/sign.log"; echo "Signing failed"; exit 1; }

mkdir -p "$HOME/Downloads"
mkdir -p "$ROOT/../server/data"
cp -f "$SIGNED" "$OUT"
cp -f "$SIGNED" "$HOME/Downloads/Stratus.apk"
cp -f "$SIGNED" "$HOME/Downloads/stratus.apk"
cp -f "$SIGNED" "$HOME/Downloads/Stratus-patched.apk"
cp -f "$SIGNED" "$ROOT/../server/data/Stratus.apk"
cp -f "$SIGNED" "$ROOT/../server/data/stratus.apk"
echo "=================================================="
echo "Stratus $VERSION_NAME"
ls -lh "$OUT"
[ -f "$HOME/Downloads/Stratus.apk" ] && ls -lh "$HOME/Downloads/Stratus.apk"
