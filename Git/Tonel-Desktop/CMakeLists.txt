cmake_minimum_required(VERSION 3.22)
project(Tonel Desktop LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── JUCE (absolute path required) ────────────────────────────────────────────
# Adjust JUCE_PATH below if JUCE is installed elsewhere.
set(JUCE_PATH "$ENV{JUCE_PATH}" CACHE PATH "Path to JUCE framework")
if(NOT JUCE_PATH)
    set(JUCE_PATH "/Users/niko/JUCE")
endif()

if(NOT EXISTS "${JUCE_PATH}")
    message(FATAL_ERROR "JUCE not found at ${JUCE_PATH}. "
        "Set -DJUCE_PATH=/path/to/JUCE or set JUCE_PATH environment variable.")
endif()

add_subdirectory(${JUCE_PATH} ${CMAKE_BINARY_DIR}/JUCE)

# ── Options ──────────────────────────────────────────────────────────────────
option(S1_MINI_MODE "Use miniaudio backend instead of JUCE audio" OFF)

# ── Include directories ──────────────────────────────────────────────────────
# spa1.h is placed alongside this CMakeLists.txt
include_directories(${CMAKE_CURRENT_SOURCE_DIR})
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/src)
# miniaudio lives in ../S1-shared/miniaudio (for S1-MINI_MODE)
get_filename_component(SHARED_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
include_directories(${SHARED_ROOT}/S1-shared)

# ── Miniaudio (S1-mini mode only) ──────────────────────────────────────────
if(S1_MINI_MODE)
    add_subdirectory(${SHARED_ROOT}/S1-shared/miniaudio ${CMAKE_BINARY_DIR}/miniaudio EXCLUDE_FROM_ALL)
endif()

# ── Find Opus ────────────────────────────────────────────────────────────────
find_package(PkgConfig REQUIRED)
pkg_check_modules(OPUS REQUIRED opus)

# ── Source files ────────────────────────────────────────────────────────────
set(SOURCES
    src/audio/JuceAudioEngine.cpp
    src/audio/AudioDeviceManager.cpp
    src/audio/OpusCodec.cpp
    src/network/NetworkSocket.cpp
    src/network/StunClient.cpp
    src/network/P2PMeshManager.cpp
    src/network/MixerServerConnection.cpp
    src/network/SignalingClient.cpp
    src/network/AudioRouter.cpp
    src/ui/AppState.cpp
    src/ui/HomeView.cpp
    src/ui/CreateRoomView.cpp
    src/ui/JoinRoomView.cpp
    src/ui/RoomView.cpp
    src/ui/SettingsView.cpp
    src/main.cpp
    src/ConfigManager.cpp
)

if(S1_MINI_MODE)
    list(APPEND SOURCES src/audio/MiniaudioEngine.cpp)
endif()

# ── Executable ───────────────────────────────────────────────────────────────
add_executable(BandRehearsal ${SOURCES})

target_compile_definitions(BandRehearsal PRIVATE
    JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
)

if(S1_MINI_MODE)
    target_compile_definitions(BandRehearsal PRIVATE S1_MINI_MODE=1)
endif()

target_link_libraries(BandRehearsal PRIVATE
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_gui_extra
)

if(S1_MINI_MODE)
    target_link_libraries(BandRehearsal PRIVATE miniaudio)
endif()

target_include_directories(BandRehearsal PRIVATE ${OPUS_INCLUDE_DIRS})
target_link_libraries(BandRehearsal PRIVATE ${OPUS_LDFLAGS})
