# ADR-001 — Technology stack

Date: {{DATE}} · Status: accepted

## Decision
| Area | Choice | Version |
|---|---|---|
| Language | Java | 25 (Gradle toolchain) |
| Backend framework | Spring Boot | {{BOOT_VERSION}} |
| Build | Gradle (Kotlin DSL) | {{GRADLE_VERSION}} |
| Database | PostgreSQL + Flyway | postgres:18 |
| Contract | OpenAPI 3 — openapi-generator (Spring interfaces), ng-openapi-gen (Angular client) | {{OPENAPI_GEN_VERSION}} / {{NG_OPENAPI_GEN_VERSION}} |
| Frontend | Angular + Angular Material (Material 3) | {{ANGULAR_VERSION}} / {{MATERIAL_VERSION}} |
| Unit tests | JUnit 5 + Testcontainers + JaCoCo + Gradle test-retry (1 retry → FLAKY, never blocking) · Angular unit-test builder (Vitest) | {{TEST_RETRY_VERSION}} |
| E2E | Playwright | {{PLAYWRIGHT_VERSION}} |
| Runtime | Docker Compose (db · backend · frontend/nginx) | — |

## Why
- Contract first: both sides are generated from `api/openapi.yaml`, so backend and frontend cannot drift.
- Versions are the latest stable at scaffold time and pinned in the build files.

## Consequences
- Docker is required for tests (Testcontainers) and for running the app.
