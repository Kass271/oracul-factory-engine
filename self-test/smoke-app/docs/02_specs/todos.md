# Spec — todos

Covers: FR-1, FR-2

## Data
| Entity | Field | Type | Rules |
|---|---|---|---|
| Todo | id | int64 | generated |
| Todo | title | string | 1..200 chars, not blank |
| Todo | done | boolean | false on create |

## Behaviour
### FR-1 — Add and list todos
- Happy path: POST /api/todos {title} → 201 Todo; GET /api/todos → all todos ordered by id
- Changes earlier behaviour: none
- Ranges & invariants: none
### FR-2 — Reject an empty title
- Errors: title "" or blank → 400 ApiError.code VALIDATION_FAILED → "title: …"
- Changes earlier behaviour: none
- Ranges & invariants: none

## API
| Method | Path | operationId | Request | Responses |
|---|---|---|---|---|
| GET | /api/todos | listTodos | — | 200 Todo[] |
| POST | /api/todos | createTodo | NewTodo | 201 Todo · 400 ApiError |

## UI
- Route `/todos` · Material form field + button + list
- data-testid: todo-title, todo-add, todo-row, todo-empty
