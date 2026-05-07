#!/bin/bash
# Package Tonel-MacOS into a distributable .dmg.
#
# Usage:   deploy/package-macos.sh
# Output:  deploy/dist/Tonel-MacOS-v<version>.dmg
#
# v6.5.2: 内测分发 — ad-hoc signed (no notarization). End users will
# see "无法验证开发者" on first launch and need to right-click → Open
# → "打开" once per version. Sufficient for handing the .dmg to band-
# mates over IM; not suitable for App Store / wide release. Notarization
# requires Apple Developer Program ($99/yr) + xcrun notarytool, deferred
# to whenever the project goes public.

set -euo pipefail

# Resolve paths relative to repo root regardless of where the script
# is invoked from. `realpath` isn't on macOS by default; we shell out
# via cd-then-pwd which works on macOS' built-in /bin/bash.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$REPO_ROOT/Tonel-MacOS"
DIST_DIR="$SCRIPT_DIR/dist"

# Read version from the same place CMake / web do — single source of
# truth. The Tonel-MacOS Xcode project's MARKETING_VERSION lives in
# project.yml but tracks an independent 0.x scheme; for distribution
# filenames we use the global v6.x.y so users can correlate downloads
# with the project's release tags.
VERSION=$(awk -F'VERSION ' '/project\(Tonel /{print $2}' "$REPO_ROOT/CMakeLists.txt" | tr -d '() LANGUAGES C CXX' | head -1)
[ -n "$VERSION" ] || { echo "[package] could not read version from CMakeLists.txt" >&2; exit 1; }

DMG_NAME="Tonel-MacOS-v${VERSION}.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"

mkdir -p "$DIST_DIR"

# ── 1. Release build ────────────────────────────────────────────────
# Until now we've been building Debug locally; for distribution we
# want Release (optimisations on, no debug-only logging cost). Output
# to a separate DerivedData so we don't clobber the local Debug build
# the user is running interactively.
echo "[package] xcodebuild Release …"
RELEASE_DD="$MACOS_DIR/build/DerivedData-Release"
xcodebuild \
    -project "$MACOS_DIR/TonelMacOS.xcodeproj" \
    -scheme TonelMacOS \
    -configuration Release \
    -derivedDataPath "$RELEASE_DD" \
    build \
    >/tmp/tonel-package.log 2>&1 \
    || { echo "[package] BUILD FAILED — see /tmp/tonel-package.log" >&2; tail -30 /tmp/tonel-package.log >&2; exit 1; }

APP_PATH="$RELEASE_DD/Build/Products/Release/TonelMacOS.app"
[ -d "$APP_PATH" ] || { echo "[package] expected .app missing: $APP_PATH" >&2; exit 1; }

# ── 2. Verify code signature ────────────────────────────────────────
# Ad-hoc sign should already be applied by Xcode (see Tonel-MacOS/
# project.yml — CODE_SIGN_STYLE=Automatic + no team = ad-hoc). Verify
# the .app launches its own signature check before we ship it; if
# `codesign -v` fails here the .dmg would surface "is damaged" on
# every user's machine.
echo "[package] codesign verify …"
codesign --verify --verbose=2 "$APP_PATH" 2>&1 | sed 's/^/  /'

# ── 3. Build the DMG ────────────────────────────────────────────────
# Plain `hdiutil create` is enough for internal distribution — we
# don't need a fancy backdrop image / Applications-symlink layout
# here. Users can drag the .app out of the mounted volume to anywhere
# they want.
#
# Format UDZO = compressed; final file ~30-40% of raw .app size.
# `-ov` overwrites if a previous run left a file in dist/.
echo "[package] hdiutil create $DMG_NAME …"
rm -f "$DMG_PATH"
hdiutil create \
    -volname "Tonel" \
    -srcfolder "$APP_PATH" \
    -ov \
    -format UDZO \
    -quiet \
    "$DMG_PATH"

DMG_BYTES=$(stat -f %z "$DMG_PATH")
DMG_MB=$(awk "BEGIN{printf \"%.1f\", $DMG_BYTES/1048576}")

echo "[package] ✅ $DMG_PATH (${DMG_MB} MB)"
echo "[package]    upload to R2: deploy/upload-r2.sh '$DMG_PATH'"
