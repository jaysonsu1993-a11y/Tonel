cmake_minimum_required(VERSION 3.14)
project(TonelServer VERSION 1.0.2 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Find libuv and opus
find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBUV REQUIRED libuv)
pkg_check_modules(OPUS REQUIRED opus)

# Find OpenSSL (required for password hashing)
find_package(OpenSSL REQUIRED)

# Add libuv library directory to linker search path
link_directories(${LIBUV_LIBRARY_DIRS})

# Optional: find nlohmann_json
find_path(NLOHMANN_JSON_INCLUDE_DIRS "nlohmann/json.hpp"
    PATHS
        ${CMAKE_SOURCE_DIR}/../libs/nlohmann_json/include
        ${CMAKE_SOURCE_DIR}/../external/nlohmann_json/include
        /usr/local/include
        /usr/include
)

set(JSON_SOURCES "")
if(NLOHMANN_JSON_INCLUDE_DIRS)
    message(STATUS "Found nlohmann/json: ${NLOHMANN_JSON_INCLUDE_DIRS}")
    add_definitions(-DUSE_NLOHMANN_JSON)
    include_directories(${NLOHMANN_JSON_INCLUDE_DIRS})
else()
    message(STATUS "Using built-in minimal JSON parser")
endif()

# Source files
set(SIGNALING_SOURCES
    src/main.cpp
    src/signaling_server.cpp
    src/room.cpp
    src/user.cpp
    src/password_hasher.cpp
)

add_executable(signaling_server ${SIGNALING_SOURCES})

target_include_directories(signaling_server PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${LIBUV_INCLUDE_DIRS}
)

target_link_libraries(signaling_server
    ${LIBUV_LIBRARIES}
    OpenSSL::Crypto
    pthread
)

# ── Mixer Server ────────────────────────────────────────────────────────────

set(MIXER_SOURCES
    src/audio_mixer.cpp
    src/mixer_server.cpp
    src/mixer_server_test.cpp
    src/AudioRecorder.cpp
)

add_executable(mixer_server ${MIXER_SOURCES})

target_include_directories(mixer_server PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${LIBUV_INCLUDE_DIRS}
    ${OPUS_INCLUDE_DIRS}
)

target_link_libraries(mixer_server
    ${LIBUV_LIBRARIES}
    -L${OPUS_LIBRARY_DIRS} -lopus
    pthread
)

target_compile_options(mixer_server PRIVATE
    -Wall -Wextra
)

# Copy binary to project root
add_custom_command(TARGET mixer_server POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:mixer_server>
        ${CMAKE_SOURCE_DIR}/../bin/mixer_server
)

target_compile_options(signaling_server PRIVATE
    -Wall -Wextra
)

# Copy binary to project root for convenience
add_custom_command(TARGET signaling_server POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:signaling_server>
        ${CMAKE_SOURCE_DIR}/../bin/signaling_server
)
