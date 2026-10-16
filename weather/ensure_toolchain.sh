#!/usr/bin/env bash
# ============================================================================
# ensure_toolchain.sh
# Dynamic resolver and bootstrapper for Gradle-free Android build toolchain.
# Checks environment variables, standard SDK paths, existing toolchains,
# and automatically downloads any missing standalone components.
# ============================================================================
set -e

DEFAULT_TOOLCHAIN="${ANDROID_TOOLCHAIN:-$HOME/.local/share/android-toolchain}"
mkdir -p "$DEFAULT_TOOLCHAIN"

# List of search paths for toolchain components
CANDIDATES=(
    "$ANDROID_TOOLCHAIN"
    "$HOME/.local/share/android-toolchain"
    "/usr/local/share/android-toolchain"
    "/opt/android-toolchain"
    "$ANDROID_HOME"
    "$ANDROID_SDK_ROOT"
    "$HOME/Android/Sdk"
    "/opt/android-sdk"
)

# ----------------------------------------------------------------------------
# 1. Resolve Java / Javac
# ----------------------------------------------------------------------------
RESOLVED_JAVAC=""
RESOLVED_JAVA=""

if [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
    RESOLVED_JAVAC="$JAVA_HOME/bin/javac"
    RESOLVED_JAVA="$JAVA_HOME/bin/java"
elif which javac >/dev/null 2>&1 && which java >/dev/null 2>&1; then
    RESOLVED_JAVAC="$(which javac)"
    RESOLVED_JAVA="$(which java)"
else
    for c in "${CANDIDATES[@]}"; do
        if [ -n "$c" ] && [ -d "$c" ]; then
            FOUND_JDK=$(find "$c" -maxdepth 3 -type f -name javac 2>/dev/null | head -n 1 || true)
            if [ -n "$FOUND_JDK" ]; then
                RESOLVED_JAVAC="$FOUND_JDK"
                RESOLVED_JAVA="$(dirname "$FOUND_JDK")/java"
                break
            fi
        fi
    done
fi

# If JDK still not found, check system JVMs or download Adoptium JDK 17
if [ -z "$RESOLVED_JAVAC" ] || [ ! -x "$RESOLVED_JAVAC" ]; then
    SYSTEM_JDK=$(find /usr/lib/jvm -maxdepth 3 -type f -name javac 2>/dev/null | head -n 1 || true)
    if [ -n "$SYSTEM_JDK" ]; then
        RESOLVED_JAVAC="$SYSTEM_JDK"
        RESOLVED_JAVA="$(dirname "$SYSTEM_JDK")/java"
    else
        echo "[Toolchain] No Java 17+ compiler found on system."
        echo "[Toolchain] Downloading Eclipse Adoptium OpenJDK 17 into $DEFAULT_TOOLCHAIN..."
        JDK_TAR="$DEFAULT_TOOLCHAIN/jdk17.tar.gz"
        curl -fSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o "$JDK_TAR"
        mkdir -p "$DEFAULT_TOOLCHAIN/jdk-17"
        tar -xzf "$JDK_TAR" -C "$DEFAULT_TOOLCHAIN/jdk-17" --strip-components=1
        rm -f "$JDK_TAR"
        RESOLVED_JAVAC="$DEFAULT_TOOLCHAIN/jdk-17/bin/javac"
        RESOLVED_JAVA="$DEFAULT_TOOLCHAIN/jdk-17/bin/java"
    fi
fi

# ----------------------------------------------------------------------------
# 2. Resolve AAPT2
# ----------------------------------------------------------------------------
RESOLVED_AAPT2=""

for c in "${CANDIDATES[@]}"; do
    if [ -n "$c" ] && [ -d "$c" ]; then
        if [ -x "$c/aapt2" ]; then
            RESOLVED_AAPT2="$c/aapt2"
            break
        fi
        FOUND_AAPT2=$(find "$c/build-tools" -type f -name aapt2 2>/dev/null | sort -V | tail -n 1 || true)
        if [ -n "$FOUND_AAPT2" ] && [ -x "$FOUND_AAPT2" ]; then
            RESOLVED_AAPT2="$FOUND_AAPT2"
            break
        fi
    fi
done

if [ -z "$RESOLVED_AAPT2" ] && which aapt2 >/dev/null 2>&1; then
    RESOLVED_AAPT2="$(which aapt2)"
fi

if [ -z "$RESOLVED_AAPT2" ] || [ ! -x "$RESOLVED_AAPT2" ]; then
    echo "[Toolchain] Downloading standalone aapt2 binary into $DEFAULT_TOOLCHAIN..."
    AAPT2_JAR="$DEFAULT_TOOLCHAIN/aapt2.jar"
    curl -fSL "https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/8.2.0-10154469/aapt2-8.2.0-10154469-linux.jar" -o "$AAPT2_JAR"
    python3 -c "import zipfile; zipfile.ZipFile('$AAPT2_JAR').extract('aapt2', '$DEFAULT_TOOLCHAIN')"
    chmod +x "$DEFAULT_TOOLCHAIN/aapt2"
    RESOLVED_AAPT2="$DEFAULT_TOOLCHAIN/aapt2"
fi

# ----------------------------------------------------------------------------
# 3. Resolve android.jar
# ----------------------------------------------------------------------------
RESOLVED_ANDROID_JAR=""

for c in "${CANDIDATES[@]}"; do
    if [ -n "$c" ] && [ -d "$c" ]; then
        if [ -f "$c/android.jar" ]; then
            RESOLVED_ANDROID_JAR="$c/android.jar"
            break
        fi
        FOUND_JAR=$(find "$c/platforms" -type f -name android.jar 2>/dev/null | sort -V | tail -n 1 || true)
        if [ -n "$FOUND_JAR" ] && [ -f "$FOUND_JAR" ]; then
            RESOLVED_ANDROID_JAR="$FOUND_JAR"
            break
        fi
    fi
done

if [ -z "$RESOLVED_ANDROID_JAR" ] || [ ! -f "$RESOLVED_ANDROID_JAR" ]; then
    echo "[Toolchain] Downloading Android platform SDK (android.jar) into $DEFAULT_TOOLCHAIN..."
    curl -fSL "https://raw.githubusercontent.com/Sable/android-platforms/master/android-33/android.jar" -o "$DEFAULT_TOOLCHAIN/android.jar"
    RESOLVED_ANDROID_JAR="$DEFAULT_TOOLCHAIN/android.jar"
fi

# ----------------------------------------------------------------------------
# 4. Resolve R8 / D8 Dexer
# ----------------------------------------------------------------------------
RESOLVED_R8_JAR=""

for c in "${CANDIDATES[@]}"; do
    if [ -n "$c" ] && [ -d "$c" ]; then
        if [ -f "$c/r8.jar" ]; then
            RESOLVED_R8_JAR="$c/r8.jar"
            break
        elif [ -f "$c/d8.jar" ]; then
            RESOLVED_R8_JAR="$c/d8.jar"
            break
        fi
        FOUND_D8=$(find "$c/build-tools" -type f -name "d8.jar" 2>/dev/null | sort -V | tail -n 1 || true)
        if [ -n "$FOUND_D8" ] && [ -f "$FOUND_D8" ]; then
            RESOLVED_R8_JAR="$FOUND_D8"
            break
        fi
    fi
done

if [ -z "$RESOLVED_R8_JAR" ] || [ ! -f "$RESOLVED_R8_JAR" ]; then
    echo "[Toolchain] Downloading standalone D8/R8 dexer into $DEFAULT_TOOLCHAIN..."
    curl -fSL "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.2.42/r8-8.2.42.jar" -o "$DEFAULT_TOOLCHAIN/r8.jar"
    RESOLVED_R8_JAR="$DEFAULT_TOOLCHAIN/r8.jar"
fi

# ----------------------------------------------------------------------------
# 5. Resolve APK Signer
# ----------------------------------------------------------------------------
RESOLVED_SIGNER_JAR=""

for c in "${CANDIDATES[@]}"; do
    if [ -n "$c" ] && [ -d "$c" ]; then
        if [ -f "$c/uber-apk-signer.jar" ]; then
            RESOLVED_SIGNER_JAR="$c/uber-apk-signer.jar"
            break
        fi
    fi
done

if [ -z "$RESOLVED_SIGNER_JAR" ] || [ ! -f "$RESOLVED_SIGNER_JAR" ]; then
    echo "[Toolchain] Downloading standalone uber-apk-signer into $DEFAULT_TOOLCHAIN..."
    curl -fSL "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar" -o "$DEFAULT_TOOLCHAIN/uber-apk-signer.jar"
    RESOLVED_SIGNER_JAR="$DEFAULT_TOOLCHAIN/uber-apk-signer.jar"
fi

# Export resolved toolchain variables for caller
export JAVA_BIN="$RESOLVED_JAVA"
export JAVAC_BIN="$RESOLVED_JAVAC"
export AAPT2="$RESOLVED_AAPT2"
export ANDROID_JAR="$RESOLVED_ANDROID_JAR"
export R8_JAR="$RESOLVED_R8_JAR"
export SIGNER_JAR="$RESOLVED_SIGNER_JAR"

echo "[Toolchain] Java compiler: $JAVAC_BIN"
echo "[Toolchain] AAPT2 binary : $AAPT2"
echo "[Toolchain] Android JAR  : $ANDROID_JAR"
echo "[Toolchain] R8/D8 Dexer  : $R8_JAR"
echo "[Toolchain] APK Signer   : $SIGNER_JAR"
