# Manual test plan — phase-01_mvp

## FR-1 — Add and list todos
| # | Step | Expected |
|---|---|---|
| 1 | Open http://localhost:4200/todos, type "Buy milk", click Add | "Buy milk" is listed |
| 2 | Reload the page | "Buy milk" is still listed |

## FR-2 — Reject an empty title
| # | Step | Expected |
|---|---|---|
| 1 | POST /api/todos with {"title":""} | 400, code VALIDATION_FAILED |
