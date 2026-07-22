---
description: >
  Guides agents in analyzing an unfamiliar software repository to discover
  its language, framework, build system, test runner, package manager, and
  conventions without assuming a specific stack.
---

# Project Analysis Skill

Use this skill when you need to understand a repository you have not seen before.

## Priority order

When analyzing a project, check sources in this order:

1. **Existing project instructions** — AGENTS.md, README.md, CONTRIBUTING.md, CLAUDE.md, opencode.json
2. **CI configuration** — .github/workflows/, .gitlab-ci.yml, Jenkinsfile, .circleci/config.yml
3. **Package or build manifests** — specific to the detected language
4. **Existing scripts** — package.json scripts, Makefile, scripts/, tasks/, justfile
5. **Existing tests** — test patterns, test directories, test configuration
6. **Existing documentation** — docs/, wiki, API docs

## Language-specific detection

### Node.js / JavaScript / TypeScript
- Manifests: package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock
- Test runners: jest, mocha, vitest, ava, tap, node --test, playwright
- Linters: eslint, prettier, biome
- Type checks: typescript (tsconfig.json)
- Build: webpack, vite, esbuild, tsc, next build, nuxt build
- Monorepo: lerna, nx, turborepo, npm/pnpm/yarn workspaces

### Python
- Manifests: pyproject.toml, setup.py, setup.cfg, requirements.txt, Pipfile, poetry.lock
- Test runners: pytest, unittest, nose
- Linters: flake8, pylint, ruff, black, isort, mypy, pyright
- Type checks: mypy, pyright, pyre
- Build: setuptools, poetry, flit, hatch
- Frameworks: Django, Flask, FastAPI

### Go
- Manifests: go.mod, go.sum
- Test: go test (standard)
- Linters: golangci-lint, staticcheck
- Build: go build
- Frameworks: gin, echo, chi, fiber

### Rust
- Manifests: Cargo.toml, Cargo.lock
- Test: cargo test
- Linters: clippy
- Build: cargo build
- Format: rustfmt

### Java / Kotlin (JVM)
- Manifests: pom.xml, build.gradle, build.gradle.kts, settings.gradle
- Test runners: JUnit, TestNG, Kotest
- Linters: checkstyle, pmd, spotbugs, detekt
- Build: Maven, Gradle
- Frameworks: Spring Boot, Micronaut, Quarkus

### C# / .NET
- Manifests: *.csproj, *.sln, Directory.Build.props
- Test runners: xUnit, NUnit, MSTest
- Linters: dotnet format, roslyn analyzers
- Build: dotnet build, msbuild

### C / C++
- Manifests: CMakeLists.txt, Makefile, configure.ac, meson.build
- Test: CTest, Google Test, Catch2, Boost.Test
- Build: CMake, Make, Meson, Bazel

### PHP
- Manifests: composer.json, composer.lock
- Test runners: PHPUnit, Pest
- Linters: phpcs, phpmd, phpstan, psalm
- Frameworks: Laravel, Symfony

### Ruby
- Manifests: Gemfile, Gemfile.lock, *.gemspec
- Test runners: RSpec, Minitest
- Linters: rubocop
- Frameworks: Rails, Sinatra

### Flutter / Dart
- Manifests: pubspec.yaml
- Test: flutter test, dart test
- Linters: dart analyze
- Build: flutter build

### Android
- Manifests: build.gradle, build.gradle.kts, settings.gradle
- Test: JUnit, Espresso, Robolectric
- Build: Gradle

### iOS / macOS
- Manifests: *.xcodeproj, *.xcworkspace, Package.swift, Podfile, Cartfile
- Test: XCTest
- Build: Xcodebuild, SwiftPM

### Godot
- Manifests: project.godot
- Script: GDScript, C#
- Test: GUT, WAT

### Docker
- Files: Dockerfile, docker-compose.yml, .dockerignore
- Build: docker build, docker compose build

## Security-sensitive areas to flag

When you detect these patterns, flag them for special attention:

- Authentication files and configurations
- Authorization logic and access control
- Encryption keys and certificate files
- Environment variable files (.env, .env.*)
- Database connection strings
- API keys and tokens
- Session management
- Payment processing
- File upload handling
- Background job processing
- Database migrations
- User data export/delete
- Third-party integrations

## Important notes

- Do not invent commands. If the project defines test, build, or lint commands in its configuration, use those.
- If no existing test system is found, report that tests were not discovered rather than running nonexistent commands.
- Prefer targeted test commands over running a full suite unless the change is broad.
- When the project has a Makefile, check it for test, build, lint, and format targets.
- When the project has CI configuration, use it as the source of truth for the expected test and build workflow.
