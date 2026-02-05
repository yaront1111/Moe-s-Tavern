# Contributing to Moe's Tavern

Welcome to Moe's Tavern! We're excited that you're interested in contributing. This guide will help you get started.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md). We expect all contributors to be respectful and inclusive.

---

## Development Environment Setup

### Prerequisites

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| JDK | 17+ | [adoptium.net](https://adoptium.net/) |
| IntelliJ IDEA | 2023.1+ | [jetbrains.com](https://www.jetbrains.com/idea/) |
| Git | Latest | [git-scm.com](https://git-scm.com/) |

### Clone the Repository

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/Moe-s-Tavern.git
cd Moe-s-Tavern

# Add upstream remote
git remote add upstream https://github.com/yaront1111/Moe-s-Tavern.git
```

### Project Structure

```
moe/
├── packages/
│   ├── moe-daemon/      # Node.js daemon (TypeScript)
│   └── moe-proxy/       # MCP stdio proxy
├── moe-jetbrains/       # JetBrains IDE plugin (Kotlin)
├── docs/                # Documentation
└── scripts/             # Cross-platform install scripts
```

---

## Building

### Daemon & Proxy (TypeScript)

**Windows (PowerShell):**
```powershell
cd packages\moe-daemon
npm install
npm run build

cd ..\moe-proxy
npm install
npm run build
```

**Mac / Linux:**
```bash
cd packages/moe-daemon
npm install
npm run build

cd ../moe-proxy
npm install
npm run build
```

### JetBrains Plugin (Kotlin)

**Windows (PowerShell):**
```powershell
cd moe-jetbrains
.\gradlew.bat build
```

**Mac / Linux:**
```bash
cd moe-jetbrains
./gradlew build
```

### Full Build (All Platforms)

**Windows:**
```powershell
.\scripts\install-all.ps1
```

**Mac / Linux:**
```bash
./scripts/install-mac.sh
```

---

## Running Tests

### Daemon & Proxy

```bash
# From project root
cd packages/moe-daemon
npm test

cd ../moe-proxy
npm test
```

### JetBrains Plugin

**Windows:**
```powershell
cd moe-jetbrains
.\gradlew.bat test
```

**Mac / Linux:**
```bash
cd moe-jetbrains
./gradlew test
```

### Run Plugin in Sandbox IDE

This launches a test IDE instance with the plugin installed:

```bash
cd moe-jetbrains
./gradlew runIde      # Mac/Linux
.\gradlew.bat runIde  # Windows
```

---

## Pull Request Process

### 1. Create a Branch

Use descriptive branch names:

```bash
git checkout -b feature/add-epic-filtering
git checkout -b fix/websocket-reconnect
git checkout -b docs/update-readme
```

### 2. Make Your Changes

- Follow our [Coding Standards](#coding-standards)
- Write tests for new functionality
- Update documentation as needed

### 3. Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(daemon): add health check endpoint
fix(plugin): correct status bar update timing
docs: update MCP tool reference
chore: bump dependencies
```

### 4. Push and Create PR

```bash
git push origin your-branch-name
```

Then create a Pull Request on GitHub. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) will guide you, but ensure:
- Clear title describing the change
- Description of what and why
- Link to related issues (if any)
- Screenshots for UI changes

### 5. Review Process

- All PRs require at least one approving review
- CI checks must pass (build, tests, lint)
- Address review feedback promptly
- Squash commits if requested

---

## Coding Standards

### TypeScript (Daemon & Proxy)

We use ESLint with strict settings:

```bash
# Check linting
npm run lint

# Auto-fix issues
npm run lint:fix
```

Key rules:
- Use `const` over `let` when possible
- Explicit return types on functions
- No `any` types (use `unknown` if needed)
- Async/await over raw promises

### Kotlin (JetBrains Plugin)

We follow [Kotlin coding conventions](https://kotlinlang.org/docs/coding-conventions.html):

- Use data classes for models
- Prefer `val` over `var`
- Use meaningful names
- Keep functions small and focused

### General Guidelines

- **Formatting**: 2-space indentation for TypeScript, 4-space for Kotlin
- **Line length**: 100 characters max
- **Comments**: Write self-documenting code; add comments for "why" not "what"
- **Error handling**: Always handle errors appropriately, never silently catch

---

## Issue Reporting

### Bug Reports

Include:
1. Steps to reproduce
2. Expected behavior
3. Actual behavior
4. Environment (OS, IDE version, Node version)
5. Error messages or screenshots

### Feature Requests

Include:
1. Problem you're trying to solve
2. Proposed solution
3. Alternatives you've considered
4. Any mockups or diagrams

---

## First-Time Contributors

Look for issues labeled:
- `good first issue` - Simple, well-scoped tasks
- `help wanted` - We'd love community help here
- `documentation` - Great for getting familiar with the project

### Quick Wins

1. Fix typos in documentation
2. Add missing JSDoc comments
3. Improve error messages
4. Add test coverage

---

## Getting Help

- **GitHub Issues**: For bugs and feature requests
- **Discussions**: For questions and ideas
- **Code Review**: Maintainers are happy to guide new contributors

---

## Release Process

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (x.0.0): Breaking changes
- **MINOR** (0.x.0): New features, backward compatible
- **PATCH** (0.0.x): Bug fixes, backward compatible

All packages maintain synchronized version numbers.

---

Thank you for contributing to Moe's Tavern! Every contribution makes the project better.
