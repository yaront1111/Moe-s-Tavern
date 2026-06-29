# ===========================================
# CMake Project Template
# Usage: Copy to project root
# ===========================================

cmake_minimum_required(VERSION 3.20)
project(MyProject
    VERSION 1.0.0
    DESCRIPTION "Project description"
    LANGUAGES CXX
)

# ===========================================
# C++ Standard and Compiler Settings
# ===========================================

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Export compile commands for IDE/tools
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ===========================================
# Build Options
# ===========================================

option(BUILD_TESTS "Build tests" ON)
option(BUILD_DOCS "Build documentation" OFF)
option(ENABLE_SANITIZERS "Enable sanitizers in Debug" ON)
option(ENABLE_COVERAGE "Enable code coverage" OFF)

# ===========================================
# Compiler Warnings
# ===========================================

add_library(project_warnings INTERFACE)

if(MSVC)
    target_compile_options(project_warnings INTERFACE /W4 /WX)
else()
    target_compile_options(project_warnings INTERFACE
        -Wall
        -Wextra
        -Wpedantic
        -Werror
        -Wshadow
        -Wnon-virtual-dtor
        -Wold-style-cast
        -Wcast-align
        -Wunused
        -Woverloaded-virtual
        -Wconversion
        -Wsign-conversion
        -Wnull-dereference
        -Wdouble-promotion
        -Wformat=2
    )

    # GCC-specific
    if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        target_compile_options(project_warnings INTERFACE
            -Wmisleading-indentation
            -Wduplicated-cond
            -Wduplicated-branches
            -Wlogical-op
        )
    endif()
endif()

# ===========================================
# Sanitizers (Debug only)
# ===========================================

add_library(project_sanitizers INTERFACE)

if(ENABLE_SANITIZERS AND NOT MSVC)
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        target_compile_options(project_sanitizers INTERFACE
            -fsanitize=address,undefined
            -fno-omit-frame-pointer
        )
        target_link_options(project_sanitizers INTERFACE
            -fsanitize=address,undefined
        )
    endif()
endif()

# ===========================================
# Dependencies (using FetchContent)
# ===========================================

include(FetchContent)

# fmt library
FetchContent_Declare(
    fmt
    GIT_REPOSITORY https://github.com/fmtlib/fmt.git
    GIT_TAG 10.1.1
)

# spdlog for logging
FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG v1.12.0
)

# CLI11 for command line parsing
FetchContent_Declare(
    cli11
    GIT_REPOSITORY https://github.com/CLIUtils/CLI11.git
    GIT_TAG v2.3.2
)

# nlohmann_json for JSON
FetchContent_Declare(
    json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
)

FetchContent_MakeAvailable(fmt spdlog cli11 json)

# ===========================================
# Main Library
# ===========================================

add_library(${PROJECT_NAME}_lib
    src/lib/example.cpp
)

target_include_directories(${PROJECT_NAME}_lib
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(${PROJECT_NAME}_lib
    PUBLIC
        fmt::fmt
        spdlog::spdlog
        nlohmann_json::nlohmann_json
    PRIVATE
        project_warnings
        project_sanitizers
)

# ===========================================
# Main Executable
# ===========================================

add_executable(${PROJECT_NAME}
    src/main.cpp
)

target_link_libraries(${PROJECT_NAME}
    PRIVATE
        ${PROJECT_NAME}_lib
        CLI11::CLI11
        project_warnings
        project_sanitizers
)

# ===========================================
# Testing
# ===========================================

if(BUILD_TESTS)
    enable_testing()

    FetchContent_Declare(
        Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG v3.5.0
    )
    FetchContent_MakeAvailable(Catch2)

    add_executable(tests
        tests/test_main.cpp
        tests/test_example.cpp
    )

    target_link_libraries(tests
        PRIVATE
            ${PROJECT_NAME}_lib
            Catch2::Catch2WithMain
            project_warnings
    )

    include(CTest)
    include(Catch)
    catch_discover_tests(tests)
endif()

# ===========================================
# Code Coverage
# ===========================================

if(ENABLE_COVERAGE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${PROJECT_NAME}_lib PRIVATE --coverage -O0 -g)
    target_link_options(${PROJECT_NAME}_lib PRIVATE --coverage)
endif()

# ===========================================
# Installation
# ===========================================

include(GNUInstallDirs)

install(TARGETS ${PROJECT_NAME}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install(TARGETS ${PROJECT_NAME}_lib
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
)

install(DIRECTORY include/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
