cmake_minimum_required(VERSION 3.22)
project(Tonel VERSION 5.1.5 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Force UTF-8 input charset
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -finput-charset=UTF-8")

message(STATUS "Tonel v5.0.3")
message(STATUS "  Build with:")
message(STATUS "    cd Tonel-Desktop-AppKit && cmake -S . -B build && cmake --build build")
message(STATUS "    cd Tonel-Desktop && cmake -S . -B build -DJUCE_PATH=/path/to/JUCE && cmake --build build")
message(STATUS "    cd server && cmake -S . -B build && cmake --build build")
message(STATUS "    cd web && npm install && npm run build")
