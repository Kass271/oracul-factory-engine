---
name: stack-rules
description: Oracul stack conventions for generated apps — Java 25 + Spring Boot 4 (Gradle Kotlin DSL), Angular + Angular Material 3, PostgreSQL + Flyway, contract-first OpenAPI generation, Docker Compose, @trace tags. Load before writing any app code, contract or test.
---

# Stack rules

## Layout of an app (`apps/<app>/`)
```
backend/    Gradle Kotlin DSL · Java 25 toolchain · Spring Boot · JUnit 5 · Testcontainers · JaCoCo · Flyway
frontend/   Angular (standalone, signals, zoneless) · Angular Material 3 · Vitest unit tests
e2e/        Playwright (tests/*.spec.ts, helper tests/evidence.ts) — runs against Docker
api/openapi.yaml   THE contract
docker-compose.yml db (postgres:18) · backend :8080 · frontend nginx :4200 (proxies /api)
docs/<phase>/...   factory documents
```

## Contract first (never bypass)
- Change the API only in `api/openapi.yaml` (analyst, spec step). Both sides regenerate from it:
  - backend: `./gradlew openApiGenerate` → `backend/build/generated/openapi` → interfaces `com.oracul.app.api.<Tag>Api`, models `com.oracul.app.api.model.*`. Runs automatically before `compileJava`.
  - frontend: `npm run generate:api` (ng-openapi-gen) → `frontend/src/app/api/` → services `api/services/<tag>.service.ts`, models `api/models/*`. Runs automatically before build/test/start.
- Generated code is never edited (hook-enforced) and not committed on the frontend (`.gitignore`).
- Errors: every non-2xx response uses `#/components/schemas/ApiError` `{ code, message }`.
- Null convention (new apps): null optional fields are left out of the JSON (`spring.jackson.default-property-inclusion=non_null`).
  So a property is either required and never null, or optional (absent = null) — never `required` + `nullable`
  (`check-contract` rejects it). A field a later phase adds therefore does not change existing responses.
- Contract changes are additive where possible (new operations, new optional fields). A new operation compiles as a
  generated default method answering 501 until a controller implements it. Renames/removals of schemas, properties or
  enum values are declared in `contract-notes.md` as `Renamed: Old → New` (one per line) — the contract sync step uses
  exactly these.
- Generated enums stay at the boundary: map them to domain enums in the controller/mapper and never `switch`
  exhaustively over a generated enum in domain code — a new enum value then fails a test, not the compile.

## Backend
- Package by capability: `com.oracul.app.<capability>` with `XController implements XApi`, `XService`, `XRepository extends JpaRepository`, `X` entity, mapper methods entity ↔ generated model.
- `@RestControllerAdvice` in `com.oracul.app.common` maps `MethodArgumentNotValidException`, `ConstraintViolationException`, not-found and business-rule exceptions to `ApiError` with 400/404/409/422 as the spec says. Never leak stack traces.
- Persistence: Flyway `V<n>__<description>.sql`, `ddl-auto=validate`, UUID or bigint identity ids as the contract says, `Instant`/`timestamptz` for time.
- Spring Boot 4 test packages: `org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest` / `AutoConfigureMockMvc`, `org.springframework.boot.test.context.SpringBootTest`; Testcontainers via the generated `TestcontainersConfiguration` (`@Import(TestcontainersConfiguration.class)`).
- Run: `cd backend && ./gradlew test` (JaCoCo XML at `build/reports/jacoco/test/jacocoTestReport.xml`).

## Frontend
- Standalone components, `inject()`, signals/`computed`, `@if`/`@for`, lazy routes in `app.routes.ts`, one folder per capability `src/app/<capability>/`.
- HTTP only via generated services; `provideHttpClient(withFetch())` is configured in `app.config.ts`.
- Angular Material for all widgets; forms with reactive forms + `mat-form-field` + `mat-error`; feedback via `MatSnackBar`.
- Every element a test touches has a `data-testid` named in the spec.
- Run: `cd frontend && npm run test:ci` (coverage in `frontend/coverage/`), `npm run build`. Dev server `npm start` proxies `/api` to :8080.

## Traceability tag
Every test that proves a requirement carries a comment `// @trace FR-x` (several allowed: `// @trace FR-1, FR-2`) on the test method/`it` or its class/`describe`. Tags must be honest — the test must actually exercise that FR.

## Commands the factory uses (from `oracul/`)
- `node factory-engine/checks/verify.mjs` — builds + tests both layers + all checks (GREEN/RED)
- `node factory-engine/bin/stack.mjs up|down|status|e2e` — Docker stack and Playwright. `up`, `down` and `e2e` hold the
  stack lock (`state/apps/<app>/stack.lock`): a second operation waits `--lock-wait <s>` (default 60, 120 for scratch)
  and then exits **3** `STACK BUSY` — never delete the lock. A failed `e2e` prints an `E2E FAILURES` block last.
  The workflows run the official E2E as `up`, then `e2e --detach` (Playwright in a background worker that holds the
  lock), then `e2e-wait --max 480` until it is done: exit 75 = still running (call again), 4 = `E2E WORKER LOST`.
  So a suite longer than the 10-minute command limit still finishes. Worker status/log: `state/apps/<app>/e2e-run.*`.
  `e2e --scratch --grep <spec file | title pattern>` = the tester's scoped verification run (test-fix only); it writes
  `e2e/report-scratch/` + `e2e/test-results-scratch/`, needs `E2E_REPORT_DIR`/`E2E_OUTPUT_DIR` support in
  `e2e/playwright.config.ts`, and is never evidence. `--dry-run` checks preconditions + lock without Docker.
- `node factory-engine/bin/state.mjs show` — where we are
