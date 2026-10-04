---
name: testing-rules
description: How Oracul writes RED tests per layer — JUnit 5 + MockMvc/Testcontainers for Spring Boot, Angular unit tests with RouterTestingHarness and HttpTestingController, Playwright E2E with screenshot evidence — and how to prove a test is red for the right reason. Load before writing tests.
---

# Testing rules

## The RED rule
A new test must **compile and fail because the behaviour is missing** — a wrong status, a missing element, missing data.
A compile error is RED for the wrong reason (it also breaks every other test). `bin/red-check.mjs` classifies this
and rejects it. So test through seams that already exist before implementation:

| Layer | Seam that exists before the code | Avoid in RED tests |
|---|---|---|
| backend | HTTP paths of the contract via MockMvc; generated models `com.oracul.app.api.model.*` | importing a service/entity class that does not exist yet |
| frontend | routes via `RouterTestingHarness`, generated services/models, `HttpTestingController` | importing a component class that does not exist yet |
| e2e | URLs, `data-testid` names from the spec | anything internal |

## Backend (JUnit 5)
Integration test through the real stack (Postgres in Testcontainers):
```java
// @trace FR-3
@SpringBootTest
@AutoConfigureMockMvc   // org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
@Import(TestcontainersConfiguration.class)
class RoomsApiIT {
  @Autowired MockMvc mvc;

  @Test void createRoomReturns201() throws Exception {
    mvc.perform(post("/api/rooms").contentType(APPLICATION_JSON).content("""
        {"name":"Orion","capacity":8}"""))
       .andExpect(status().isCreated())
       .andExpect(jsonPath("$.name").value("Orion"));
  }

  @Test void rejectsZeroCapacity() throws Exception {   // error path from the spec
    mvc.perform(post("/api/rooms").contentType(APPLICATION_JSON).content("""
        {"name":"Orion","capacity":0}"""))
       .andExpect(status().isBadRequest())
       .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
  }
}
```
Isolate data per test (unique names, or `@Sql`/repository cleanup in `@BeforeEach`). Never depend on test order.
New apps carry `src/test/resources/junit-platform.properties` with `junit.jupiter.execution.timeout.default = 120 s`:
a hanging backend test fails after 120 s with its name. Keep every test method and every parameterized invocation
well below that (an exhaustive range is many fast invocations, not one long loop).

## Frontend (Angular unit tests, Vitest runner)
```ts
// @trace FR-3
describe('Rooms page', () => {
  it('lists rooms from the API', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
    const harness = await RouterTestingHarness.create('/rooms');
    TestBed.inject(HttpTestingController).expectOne((r) => r.url.endsWith('/api/rooms')).flush([{ id: '1', name: 'Orion', capacity: 8 }]);
    await harness.fixture.whenStable();
    expect(harness.routeNativeElement?.querySelector('[data-testid="room-row"]')?.textContent).toContain('Orion');
  });
});
```
Import `routes` from `app.routes.ts` — a missing route makes the test fail, not the compile.

## E2E (Playwright, against Docker)
```ts
import { expect, test } from '@playwright/test';
import { evidence } from './evidence';

// @trace FR-3
test('FR-3 user creates a room', async ({ page }) => {
  await page.goto('/rooms');
  await page.getByTestId('room-name').fill(`Orion ${Date.now()}`);
  await page.getByTestId('room-save').click();
  await expect(page.getByTestId('room-row').first()).toBeVisible();
  await evidence(page, 'FR-3', 'room-created');   // → docs/<phase>/05_release/qa/screenshots/FR-3-room-created.png
});
```
Every FR with `UI: yes` has one E2E test with `evidence(...)`. E2E is not part of the RED check (`red-check` runs unit and
integration tests only), but every slice runs `stack.mjs e2e` after verify is GREEN and before review, and Step 5 runs it again.
The official E2E run happens only in subStep `e2e` (hook-enforced, serialised by the stack lock). In a test-fix round the
tester may verify an E2E repair with `stack.mjs e2e --scratch --grep <spec file>`; it writes `e2e/report-scratch/` and
`e2e/test-results-scratch/` and is never evidence.

## When a later spec changes behaviour
A spec line `Changes earlier behaviour: <old> → <new> (tests: <files>)` makes those tests outdated. The tester updates
them in the RED step (they then fail until the builders deliver `<new>`). Keep the `@trace` tags and the assertion strength.
red-check rejects the slice (NOT-RED) if a listed file is untouched, and (WRONG-REASON) if an older test the tester did
**not** touch starts failing — production code did not change, so the new tests broke it. With `--scope slice` the
untouched older tests do not run in red-check; the slice gate's full verify runs them, and triage sends a broken one to
the tester.

## Ranges and invariants
For every spec line `Ranges & invariants: …` write one test that covers the whole domain, not one example.
red-check requires a parameterized or looping test tagged with that FR.
```java
// @trace FR-5
@ParameterizedTest(name = "budget {0}")
@MethodSource("budgets")
void budgetClassifiedForEveryValue(int budget, String expected) throws Exception {
  mvc.perform(get("/api/runs/estimate").param("budget", String.valueOf(budget)))
     .andExpect(jsonPath("$.level").value(expected));
}
static Stream<Arguments> budgets() {   // every value of a small domain; boundaries ±1 of a large one
  return IntStream.rangeClosed(0, 60).mapToObj(b -> Arguments.of(b, b < 50 ? "OK" : "LOW"));
}
```
```ts
// @trace FR-6
it.each([1, 2, 6, 7, 8, 20])('label with %i words', (n) => {
  const label = Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  expect(shortLabel(label).split(' ').length).toBe(Math.min(n, 7));
});
```
Invariants ("sorted by rank", "count shown = items returned") are asserted over the whole result, for several data sets.
No randomness: enumerate the values, so a failure is reproducible.

## Self-check (before the tester finishes the RED stage)
Run `node <engine>/bin/red-check.mjs --slice <slice> --scope slice` yourself — at most 3 times. It runs only the
related tests (the slice's tagged tests, the tests its spec supersedes, the test files you changed); the slice gate
runs the whole suite later. It must print `RESULT: RED`. It flags as WRONG-REASON:
compile errors, Mockito misuse, a Spring context or TestBed that does not start, `expected:<8> but was:<8>` (same text,
different type), and older untouched tests that now fail. Then read every failure message and ask, per test:
"what is the smallest production change that makes this pass without touching the test?" If there is none, the test is
broken. The usual test bugs:
- **Numeric types** — `jsonPath("$.n").value(8L)` never equals JSON `8` (Integer). Use the type JSON yields, or a
  matcher on `Number`.
- **Stubs/fakes not scripted** — every outbound call the code path makes (incl. retries and extra calls added by this
  slice) has a stub/response; strict stubs: no unused stubbing.
- **Leaking state** — rows, files, static fields, singleton beans, fake-server request logs and counters from one test
  are visible in the next. Reset in `@BeforeEach`/`beforeEach` (`resetAll()`, `resetRequests()`, delete rows) or use
  unique ids; assert counts relative to the test's own data, never global totals.
- **Unfinished async work** — a run/job/subscription started by one test must be awaited or cancelled before it ends.
- **Unreachable expectations** — values that contradict the fixture data or the spec (wrong count, wrong order).

## Coverage
Coverage may never drop (`check-coverage`). Cover error paths, not getters.
