# Contract notes — {{PHASE}}

Decisions behind `api/openapi.yaml` (naming, error model, pagination, ids, dates).

- Errors: every 4xx/5xx returns `#/components/schemas/ApiError` { code, message }.
- …
