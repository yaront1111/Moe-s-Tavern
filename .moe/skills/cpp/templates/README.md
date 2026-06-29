# C++ Templates

CMake build configuration templates for modern C++ projects.

## Files

| Template | Purpose |
|----------|---------|
| `CMakeLists.txt` | Modern CMake project setup |

## Usage

### Quick Start

```bash
# Copy template
cp templates/CMakeLists.txt ./CMakeLists.txt

# Create project structure
mkdir -p src/lib include tests
touch src/main.cpp src/lib/example.cpp
touch include/example.hpp tests/test_main.cpp tests/test_example.cpp

# Configure and build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build

# Run
./build/MyProject

# Run tests
ctest --test-dir build
```

## Features

| Feature | Implementation |
|---------|----------------|
| C++ Standard | C++20 |
| Package Manager | FetchContent |
| Testing | Catch2 |
| JSON | nlohmann/json |
| Logging | spdlog |
| CLI | CLI11 |
| Formatting | fmt |
| Sanitizers | ASan, UBSan |
| Warnings | Strict settings |

## Build Options

| Option | Default | Description |
|--------|---------|-------------|
| `BUILD_TESTS` | ON | Build test suite |
| `BUILD_DOCS` | OFF | Build documentation |
| `ENABLE_SANITIZERS` | ON | Enable ASan/UBSan in Debug |
| `ENABLE_COVERAGE` | OFF | Enable code coverage |

```bash
# Disable tests
cmake -B build -DBUILD_TESTS=OFF

# Enable coverage
cmake -B build -DENABLE_COVERAGE=ON
```

## Project Structure

```
my-project/
├── CMakeLists.txt
├── include/
│   └── example.hpp
├── src/
│   ├── main.cpp
│   └── lib/
│       └── example.cpp
├── tests/
│   ├── test_main.cpp
│   └── test_example.cpp
└── build/
```

## Common Commands

```bash
# Configure (Debug)
cmake -B build -DCMAKE_BUILD_TYPE=Debug

# Configure (Release)
cmake -B build -DCMAKE_BUILD_TYPE=Release

# Build
cmake --build build -j$(nproc)

# Run tests
ctest --test-dir build --output-on-failure

# Install
cmake --install build --prefix /usr/local

# Clean
cmake --build build --target clean
```

## Adding Dependencies

### Via FetchContent

```cmake
FetchContent_Declare(
    new_lib
    GIT_REPOSITORY https://github.com/org/new_lib.git
    GIT_TAG v1.0.0
)
FetchContent_MakeAvailable(new_lib)

target_link_libraries(${PROJECT_NAME}_lib PUBLIC new_lib::new_lib)
```

### Via find_package

```cmake
find_package(OpenSSL REQUIRED)
target_link_libraries(${PROJECT_NAME}_lib PUBLIC OpenSSL::SSL)
```

## Compiler Support

| Compiler | Minimum Version |
|----------|-----------------|
| GCC | 10+ |
| Clang | 12+ |
| MSVC | 2019+ |

## IDE Integration

The template enables `compile_commands.json` export for IDE support:

```bash
# Link for clangd/LSP
ln -s build/compile_commands.json .
```
