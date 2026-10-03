# Requirements — phase-01_mvp

Status: APPROVED ✔ 2026-10-02

## Functional

### FR-1 — Create a room
- UI: yes
- Description: A user adds a room.
- Acceptance:
  - Given the rooms page, when I save "Orion" with capacity 8, then it is listed
  - Given capacity 0, when I save, then I see an error

### FR-2 — Search rooms by name
- UI: no
- Description: The API filters rooms by name.
- Acceptance:
  - Given rooms Orion and Vega, when I search "Or", then only Orion is returned

## Non-functional

### NFR-1 — Response time
- Description: list responds fast
- Acceptance:
  - p95 under 300 ms with 1000 rooms
