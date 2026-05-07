cmake_minimum_required(VERSION 3.22)
project(Tonel VERSION 6.5.12 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Force UTF-8 input charset
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -finput-charset=UTF-8")

# Tonel does not have a unified build at the repo root — each module
# has its own build system, intentionally. The root project() call
# above only exists so `bump-version.sh` has a single canonical place
# to read/write the version number from.
#
# Build commands per module:
#   cd Tonel-MacOS && open TonelMacOS.xcodeproj   # SwiftUI macOS client
#   cd server && cmake -S . -B build && cmake --build build
#   cd web && npm install && npm run build
message(STATUS "Tonel v${CMAKE_PROJECT_VERSION} — see per-module build instructions above")
