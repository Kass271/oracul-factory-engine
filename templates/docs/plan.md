# Plan — {{PHASE}}

Status: DRAFT

Slices are built in this order. A slice starts only when every slice in "Depends on" is DONE.
Every FR of this phase is in exactly one slice.

| Slice | FRs | Depends on | Scope |
|---|---|---|---|
| 01_<name> | FR-1, FR-2 | — | <backend + frontend scope> |
| 02_<name> | FR-3 | 01_<name> | … |

## Dependency graph

```
01_<name> ──► 02_<name>
```

## Risks
- …
