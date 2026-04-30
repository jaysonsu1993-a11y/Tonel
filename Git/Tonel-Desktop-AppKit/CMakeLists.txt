cmake_minimum_required(VERSION 3.21)
project(Tonel-Desktop-AppKit VERSION 4.3.7 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 17)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)

# macOS deployment target — use empty string to auto-detect current SDK
set(CMAKE_OSX_DEPLOYMENT_TARGET "" CACHE STRING "Minimum macOS version (empty=auto)")

# ── Source files ─────────────────────────────────────────────────────────────

set(SOURCES
    src/main.mm
    src/AppDelegate.mm
    src/MainWindowController.mm
    src/AppState.mm
    src/ui/S1RoundedButton.mm
    src/ui/HomeViewController.mm
    src/ui/RoomViewController.mm
    src/ui/SettingsViewController.mm
    src/ui/CreateRoomViewController.mm
    src/ui/JoinRoomViewController.mm
    src/bridge/AudioBridge.mm
    src/bridge/NetworkBridge.mm
    src/bridge/S1SignalingClient.mm
    src/bridge/MixerBridge.mm
)

# ── App bundle ────────────────────────────────────────────────────────────────

add_executable(S1BandRehearsal MACOSX_BUNDLE ${SOURCES})

set_target_properties(S1BandRehearsal PROPERTIES
    BUNDLE TRUE
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist"
    MACOSX_BUNDLE_BUNDLE_NAME "BandRehearsal"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "com.s1.bandrehearsal"
    XCODE_ATTRIBUTE_ENABLE_HARDENED_RUNTIME NO
    XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY ""
    XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED NO
    XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES
)

# ── Include paths ─────────────────────────────────────────────────────────────

target_include_directories(S1BandRehearsal PRIVATE
    src
    src/bridge
    # SPA1 protocol header
    ${CMAKE_CURRENT_SOURCE_DIR}/../Tonel-Desktop
    # miniaudio (header-only)
    ${CMAKE_CURRENT_SOURCE_DIR}/../libs/miniaudio
)

# ── Frameworks ────────────────────────────────────────────────────────────────

find_library(APPKIT_FW        AppKit        REQUIRED)
find_library(FOUNDATION_FW    Foundation    REQUIRED)
find_library(COREAUDIO_FW     CoreAudio     REQUIRED)
find_library(AUDIOTOOLBOX_FW  AudioToolbox  REQUIRED)
find_library(COREMIDI_FW      CoreMIDI      REQUIRED)

target_link_libraries(S1BandRehearsal PRIVATE
    ${APPKIT_FW}
    ${FOUNDATION_FW}
    ${COREAUDIO_FW}
    ${AUDIOTOOLBOX_FW}
    ${COREMIDI_FW}
)

# ── Compile flags ─────────────────────────────────────────────────────────────

target_compile_options(S1BandRehearsal PRIVATE
    -Wall
    -Wno-deprecated-declarations
    # Enable ARC for Objective-C++ files to support __weak references
    -fobjc-arc
    # Silence miniaudio verbose warnings
    -Wno-unused-function
    -Wno-missing-field-initializers
)
