---
name: clarify
description: Oracul Step 1 — the requirements dialog with the user. Saves the idea verbatim, asks batched clarification questions with proposed defaults, logs answers, writes numbered FR/NFR requirements with acceptance criteria, and repeats until the user approves. Used by the factory skill; runs in the main session (subagents cannot talk to the user).
---

# Clarify (Step 1 — scope)

`$ENGINE` = the `factory-engine` folder (from `node factory-engine/bin/state.mjs paths`). `$PHASE_DIR` = `apps/<app>/docs/<phase>`.

## 1. Save the idea
Write `$PHASE_DIR/01_scope/idea.md` from `$ENGINE/templates/docs/idea.md` with the user's prompt **verbatim**.
For phase 02+ also read every earlier phase's requirements — the new phase extends the same app.

## 2. Question rounds
Ask in batches of **at most 5 questions**, as one numbered message. Give each question a proposed default so the user
can answer "defaults ok". Cover, in this order, only what the idea leaves open:
1. users and roles (who uses it, is login needed?)
2. main flows (what does each role do, step by step?)
3. data (which things are stored, which fields, which are required, uniqueness)
4. business rules and limits (conflicts, states, permissions, numbers)
5. error cases (what must the user see when something is wrong?)
6. non-functional (data volume, performance, language, accessibility)
7. out of scope (what we explicitly do NOT build now)

After every answer, append to `$PHASE_DIR/01_scope/clarification-log.md` (template `$ENGINE/templates/docs/clarification-log.md`):
a `## Round N — <date>` section with a table of question → answer (mark accepted defaults "(default accepted)").
Stop asking when every category is answered or defaulted — usually 2–3 rounds. Never ask what the user already said.

## 3. Draft requirements
Get the next free ids: `node $ENGINE/bin/state.mjs next-fr` (numbering continues across phases).
Write `$PHASE_DIR/01_scope/requirements.md` from `$ENGINE/templates/docs/requirements.md`. Keep the shapes exactly
(the checks parse them):
```
Status: DRAFT

### FR-1 — Create a meeting room
- UI: yes
- Description: An admin adds a room with a name and a capacity so people can book it.
- Acceptance:
  - Given I am on the rooms page, when I save name "Orion" and capacity 8, then "Orion (8)" appears in the list
  - Given capacity 0, when I save, then I see "Capacity must be between 1 and 100" and nothing is saved
```
Rules: one behaviour per FR; observable Given/When/Then; at least one error-path criterion where input is involved;
`UI: yes` when a person sees it in the browser; NFRs measurable; an "Out of scope" list.

## 4. Approval loop
Show the user a compact summary: the FR list (id — title — UI), NFRs, out of scope. Ask: **"Approve the scope, or tell me what to change."**
- Changes → edit requirements.md, log the change as a new round, show again.
- Approved (any clear yes) → run:
  ```
  node $ENGINE/bin/state.mjs approve scope
  node $ENGINE/checks/check-artifacts.mjs --step 01_scope
  node $ENGINE/bin/commit.mjs --message "<phase> 01_scope: requirements approved (FR-a..FR-b)"
  ```
Never write "Status: APPROVED" yourself and never approve on the user's behalf.
