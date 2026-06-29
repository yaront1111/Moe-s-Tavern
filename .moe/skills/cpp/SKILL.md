---
name: cpp
description: Use when writing, reviewing, or debugging modern C++ (C++11 and beyond) — .cpp/.cc/.cxx/.h/.hpp files, CMake builds, smart pointers, RAII, move semantics, templates, STL, or concurrency.
domain: programming-languages
version: 1.0.0
tags:
  - cpp
  - c++
  - stl
  - raii
  - templates
  - memory
triggers:
  keywords:
    primary:
      - cpp
      - c++
      - cmake
      - stl
      - template
      - raii
    secondary:
      - smart pointer
      - move
      - constexpr
      - lambda
      - boost
      - qt
  context_boost:
    - systems
    - performance
    - embedded
    - game
    - graphics
  context_penalty:
    - python
    - javascript
    - java
    - web
  priority: high
metadata:
  mcpmarket-version: 1.0.0
---
# C++

## Overview

Modern C++ (C++11 and beyond) patterns including RAII, smart pointers, templates, and STL.

---

## Modern C++ Fundamentals

### Smart Pointers

```cpp
#include <memory>
#include <iostream>

// unique_ptr - exclusive ownership
class Resource {
public:
    Resource() { std::cout << "Resource acquired\n"; }
    ~Resource() { std::cout << "Resource released\n"; }
    void use() { std::cout << "Resource used\n"; }
};

void unique_ptr_example() {
    // Create unique_ptr
    auto ptr = std::make_unique<Resource>();
    ptr->use();

    // Transfer ownership
    auto ptr2 = std::move(ptr);
    // ptr is now nullptr

    // Array support
    auto arr = std::make_unique<int[]>(10);
}

// shared_ptr - shared ownership
void shared_ptr_example() {
    auto shared1 = std::make_shared<Resource>();
    {
        auto shared2 = shared1; // Reference count = 2
        shared2->use();
    } // shared2 destroyed, count = 1

    std::cout << "Use count: " << shared1.use_count() << "\n";
} // shared1 destroyed, resource released

// weak_ptr - non-owning reference
class Node {
public:
    std::shared_ptr<Node> next;
    std::weak_ptr<Node> prev; // Avoid circular reference

    ~Node() { std::cout << "Node destroyed\n"; }
};

void weak_ptr_example() {
    auto node1 = std::make_shared<Node>();
    auto node2 = std::make_shared<Node>();

    node1->next = node2;
    node2->prev = node1; // weak_ptr, no ownership

    if (auto locked = node2->prev.lock()) {
        // Use locked (shared_ptr)
    }
}
```

### RAII Pattern

```cpp
#include <fstream>
#include <mutex>

// File wrapper with RAII
class File {
    std::fstream file_;

public:
    explicit File(const std::string& filename)
        : file_(filename, std::ios::in | std::ios::out) {
        if (!file_.is_open()) {
            throw std::runtime_error("Failed to open file");
        }
    }

    ~File() {
        if (file_.is_open()) {
            file_.close();
        }
    }

    // Delete copy operations
    File(const File&) = delete;
    File& operator=(const File&) = delete;

    // Allow move operations
    File(File&& other) noexcept : file_(std::move(other.file_)) {}
    File& operator=(File&& other) noexcept {
        file_ = std::move(other.file_);
        return *this;
    }

    void write(const std::string& data) {
        file_ << data;
    }
};

// Lock guard (RAII for mutex)
class ThreadSafeCounter {
    mutable std::mutex mutex_;
    int count_ = 0;

public:
    void increment() {
        std::lock_guard<std::mutex> lock(mutex_);
        ++count_;
    }

    int get() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return count_;
    }
};

// Scoped cleanup
template<typename F>
class ScopeGuard {
    F cleanup_;
    bool active_ = true;

public:
    explicit ScopeGuard(F cleanup) : cleanup_(std::move(cleanup)) {}

    ~ScopeGuard() {
        if (active_) cleanup_();
    }

    void dismiss() { active_ = false; }

    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;
};

// Usage
void example() {
    auto resource = acquireResource();
    ScopeGuard guard([&]() { releaseResource(resource); });

    // Do work...

    guard.dismiss(); // Don't cleanup if successful
}
```

### Move Semantics

```cpp
#include <vector>
#include <string>
#include <utility>

class Buffer {
    std::unique_ptr<char[]> data_;
    size_t size_;

public:
    // Constructor
    explicit Buffer(size_t size) : data_(new char[size]), size_(size) {}

    // Copy constructor
    Buffer(const Buffer& other) : data_(new char[other.size_]), size_(other.size_) {
        std::copy(other.data_.get(), other.data_.get() + size_, data_.get());
    }

    // Move constructor
    Buffer(Buffer&& other) noexcept
        : data_(std::move(other.data_)), size_(other.size_) {
        other.size_ = 0;
    }

    // Copy assignment
    Buffer& operator=(const Buffer& other) {
        if (this != &other) {
            data_.reset(new char[other.size_]);
            size_ = other.size_;
            std::copy(other.data_.get(), other.data_.get() + size_, data_.get());
        }
        return *this;
    }

    // Move assignment
    Buffer& operator=(Buffer&& other) noexcept {
        if (this != &other) {
            data_ = std::move(other.data_);
            size_ = other.size_;
            other.size_ = 0;
        }
        return *this;
    }

    size_t size() const { return size_; }
};

// Perfect forwarding
template<typename T, typename... Args>
std::unique_ptr<T> make_unique_custom(Args&&... args) {
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
}
```

---

## Templates

### Function Templates

```cpp
#include <type_traits>
#include <concepts>

// Basic template
template<typename T>
T max(T a, T b) {
    return (a > b) ? a : b;
}

// Template specialization
template<>
const char* max<const char*>(const char* a, const char* b) {
    return (strcmp(a, b) > 0) ? a : b;
}

// SFINAE (Substitution Failure Is Not An Error)
template<typename T>
typename std::enable_if<std::is_integral<T>::value, T>::type
double_value(T value) {
    return value * 2;
}

// C++20 Concepts
template<typename T>
concept Numeric = std::is_arithmetic_v<T>;

template<Numeric T>
T add(T a, T b) {
    return a + b;
}

// Requires clause
template<typename T>
requires std::is_default_constructible_v<T>
T create_default() {
    return T{};
}

// Variadic templates
template<typename... Args>
void print(Args... args) {
    (std::cout << ... << args) << "\n";
}

// Fold expressions
template<typename... Args>
auto sum(Args... args) {
    return (args + ...);
}
```

### Class Templates

```cpp
// Generic container
template<typename T, size_t N>
class Array {
    T data_[N];

public:
    constexpr size_t size() const { return N; }

    T& operator[](size_t index) {
        if (index >= N) throw std::out_of_range("Index out of range");
        return data_[index];
    }

    const T& operator[](size_t index) const {
        if (index >= N) throw std::out_of_range("Index out of range");
        return data_[index];
    }

    T* begin() { return data_; }
    T* end() { return data_ + N; }
    const T* begin() const { return data_; }
    const T* end() const { return data_ + N; }
};

// Template with default arguments
template<typename T, typename Allocator = std::allocator<T>>
class Vector {
    // ...
};

// Partial specialization
template<typename T>
class Container<T*> {
    // Specialization for pointer types
};

// CRTP (Curiously Recurring Template Pattern)
template<typename Derived>
class Counter {
    static inline int count_ = 0;

public:
    Counter() { ++count_; }
    ~Counter() { --count_; }

    static int count() { return count_; }
};

class Widget : public Counter<Widget> {
    // Widget inherits counting behavior
};
```

---

## STL Containers and Algorithms

```cpp
#include <vector>
#include <map>
#include <unordered_map>
#include <set>
#include <algorithm>
#include <numeric>

void container_examples() {
    // vector
    std::vector<int> vec{1, 2, 3, 4, 5};
    vec.push_back(6);
    vec.emplace_back(7); // Construct in place

    // map
    std::map<std::string, int> ordered_map;
    ordered_map["one"] = 1;
    ordered_map.insert({"two", 2});
    ordered_map.try_emplace("three", 3);

    // unordered_map
    std::unordered_map<std::string, int> hash_map;
    hash_map["one"] = 1;

    // set
    std::set<int> ordered_set{3, 1, 4, 1, 5};
    auto [iter, inserted] = ordered_set.insert(9);
}

void algorithm_examples() {
    std::vector<int> vec{5, 2, 8, 1, 9, 3};

    // Sort
    std::sort(vec.begin(), vec.end());
    std::sort(vec.begin(), vec.end(), std::greater<int>());

    // Find
    auto it = std::find(vec.begin(), vec.end(), 8);
    auto it2 = std::find_if(vec.begin(), vec.end(), [](int n) { return n > 5; });

    // Transform
    std::vector<int> doubled(vec.size());
    std::transform(vec.begin(), vec.end(), doubled.begin(), [](int n) { return n * 2; });

    // Accumulate
    int sum = std::accumulate(vec.begin(), vec.end(), 0);

    // Remove-erase idiom
    vec.erase(std::remove_if(vec.begin(), vec.end(), [](int n) { return n < 3; }), vec.end());

    // C++20 ranges (simplified)
    // auto result = vec | std::views::filter([](int n) { return n > 3; })
    //                   | std::views::transform([](int n) { return n * 2; });
}
```

---

## Concurrency

```cpp
#include <thread>
#include <future>
#include <mutex>
#include <condition_variable>
#include <atomic>

// Basic threading
void thread_example() {
    std::thread t([]() {
        std::cout << "Hello from thread\n";
    });
    t.join();
}

// async/future
std::future<int> async_example() {
    return std::async(std::launch::async, []() {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        return 42;
    });
}

// promise/future
void promise_example() {
    std::promise<int> promise;
    std::future<int> future = promise.get_future();

    std::thread producer([&promise]() {
        promise.set_value(42);
    });

    int result = future.get();
    producer.join();
}

// Thread-safe queue
template<typename T>
class ThreadSafeQueue {
    std::queue<T> queue_;
    mutable std::mutex mutex_;
    std::condition_variable cond_;

public:
    void push(T value) {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push(std::move(value));
        cond_.notify_one();
    }

    T pop() {
        std::unique_lock<std::mutex> lock(mutex_);
        cond_.wait(lock, [this]() { return !queue_.empty(); });
        T value = std::move(queue_.front());
        queue_.pop();
        return value;
    }

    bool try_pop(T& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (queue_.empty()) return false;
        value = std::move(queue_.front());
        queue_.pop();
        return true;
    }
};

// Atomic operations
class AtomicCounter {
    std::atomic<int> count_{0};

public:
    void increment() { count_.fetch_add(1, std::memory_order_relaxed); }
    int get() const { return count_.load(std::memory_order_relaxed); }
};
```

---

## Lambda Expressions

```cpp
#include <functional>

void lambda_examples() {
    // Basic lambda
    auto add = [](int a, int b) { return a + b; };

    // Capture by value
    int x = 10;
    auto by_value = [x]() { return x; };

    // Capture by reference
    auto by_ref = [&x]() { x++; };

    // Capture all by value
    auto all_value = [=]() { return x; };

    // Capture all by reference
    auto all_ref = [&]() { x++; };

    // Mutable lambda (modify captured values)
    auto mutable_lambda = [x]() mutable { return ++x; };

    // Generic lambda (C++14)
    auto generic = [](auto a, auto b) { return a + b; };

    // Init capture (C++14)
    auto ptr = std::make_unique<int>(42);
    auto capture_move = [p = std::move(ptr)]() { return *p; };

    // Template lambda (C++20)
    auto template_lambda = []<typename T>(std::vector<T>& vec) {
        return vec.size();
    };

    // Constexpr lambda (C++17)
    constexpr auto square = [](int n) constexpr { return n * n; };
    static_assert(square(5) == 25);
}

// Storing lambdas
class EventHandler {
    std::function<void(int)> handler_;

public:
    void set_handler(std::function<void(int)> handler) {
        handler_ = std::move(handler);
    }

    void trigger(int value) {
        if (handler_) handler_(value);
    }
};
```

---

## Error Handling

```cpp
#include <stdexcept>
#include <optional>
#include <variant>
#include <expected> // C++23

// Custom exception
class DatabaseError : public std::runtime_error {
    int error_code_;

public:
    DatabaseError(const std::string& message, int code)
        : std::runtime_error(message), error_code_(code) {}

    int error_code() const { return error_code_; }
};

// std::optional for nullable values
std::optional<int> find_value(const std::string& key) {
    if (key == "answer") return 42;
    return std::nullopt;
}

void optional_usage() {
    auto result = find_value("answer");

    if (result) {
        std::cout << "Found: " << *result << "\n";
    }

    int value = result.value_or(0);
}

// std::variant for type-safe union
using Result = std::variant<int, std::string>;

Result compute(bool success) {
    if (success) return 42;
    return std::string("error");
}

void variant_usage() {
    Result r = compute(true);

    std::visit([](auto&& arg) {
        using T = std::decay_t<decltype(arg)>;
        if constexpr (std::is_same_v<T, int>) {
            std::cout << "Success: " << arg << "\n";
        } else {
            std::cout << "Error: " << arg << "\n";
        }
    }, r);
}

// std::expected (C++23)
// std::expected<int, std::string> divide(int a, int b) {
//     if (b == 0) return std::unexpected("Division by zero");
//     return a / b;
// }
```

---

## Related Skills

- [[system-design]] - Systems programming
- [[performance-optimization]] - Low-level optimization
- [[desktop-apps]] - Native applications
