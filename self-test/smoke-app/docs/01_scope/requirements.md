# Requirements — phase-01_mvp

Status: DRAFT

## Functional

### FR-1 — Add and list todos
- UI: yes
- Description: A user types a title, adds it, and sees it in the list; the list survives a reload.
- Acceptance:
  - Given the todos page, when I add "Buy milk", then "Buy milk" appears in the list
  - Given a todo was added, when I reload the page, then it is still listed

### FR-2 — Reject an empty title
- UI: no
- Description: The API refuses todos without a title.
- Acceptance:
  - Given an empty title, when it is posted, then the API answers 400 with code VALIDATION_FAILED

## Non-functional

### NFR-1 — Persistence
- Description: Todos are stored in PostgreSQL.
- Acceptance:
  - Covered by the Testcontainers integration test

## Out of scope
- Editing, deleting and completing todos
