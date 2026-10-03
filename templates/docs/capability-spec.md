# Spec — <capability name>

Covers: FR-x, FR-y

## Purpose
<what this capability gives the user>

## Data
| Entity | Field | Type | Rules |
|---|---|---|---|

## Behaviour
### FR-x — <title>
- Happy path: …
- Rules: …
- Errors: <input> → <HTTP status + ApiError.code> → <message the user sees>
- Changes earlier behaviour: none | <old> → <new> (tests: <app-relative test files that assert <old>> | none)
  ← required from Step 4a on; one line per change. Find them: grep the existing tests for every path, field,
    ApiError.code, data-testid, ordering and call count this FR touches.
- Ranges & invariants: none | <input domains and rules that must hold for every value>
  ← required from Step 4a on, e.g. "budget 0..60 → 0..49 ok, 50..60 BUDGET_LOW; label 1..7 words; events sorted by rank".
    Each non-none line gets a parameterized/exhaustive test.

## API (must match api/openapi.yaml)
| Method | Path | operationId | Request | Responses |
|---|---|---|---|---|

## UI
- Route: `/…` · Material components: …
- States: loading · empty · error · success
