---
name: qa-rules
description: Oracul QA documentation rules — what the release QA pack contains, which file is generated vs written, and the evidence rule (no ✔ without a link to a report or screenshot). Load before writing QA docs.
---

# QA rules

## The QA pack (`docs/<phase>/05_release/qa/`)
| File | Made by | Source |
|---|---|---|
| `traceability.md` | `checks/gen-traceability.mjs` — never by hand | `@trace` tags, JUnit XML, Playwright JSON, screenshots |
| `screenshots/FR-x-*.png` | Playwright `evidence()` during `stack.mjs e2e` | the running Docker stack |
| `test-plan.md` | qa-documenter | specs + requirements |
| `acceptance-report.md` | qa-documenter | traceability + reports + screenshots |
| `how-to-run.md` | qa-documenter | template + real seed data |

## Evidence rule
- A ✔ is allowed only when `traceability.md` shows ✔ for that FR.
- Every ✔ row carries a markdown link: `[FR-3-room-created.png](screenshots/FR-3-room-created.png)` and/or `[traceability](traceability.md)`.
- FRs of BLOCKED slices are listed as BLOCKED with the reason from `failure-note.md` — never hidden, never ✔.
- Open `low` review findings are listed in their own section.
- Numbers (tests run, passed) are copied from reports, never estimated.

## Test plan
One section per FR of the phase; steps a human can follow against `http://localhost:4200`; expected results taken from
the acceptance criteria; include at least one error-path step per FR that has one.

## Checked by
`node factory-engine/checks/check-artifacts.mjs --step 05_release` (mentions every FR, evidence links, screenshots per UI FR).
