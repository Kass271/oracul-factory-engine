---
name: run
description: Start (or stop) the active Oracul app in Docker without rebuilding the factory flow, and print its URLs. Use when the user says "run the app", "start it", "stop the app".
---

# Run

From `oracul/`:
- start: `node factory-engine/bin/stack.mjs up --mode run` (builds images when needed, waits for backend health + frontend)
- stop: `node factory-engine/bin/stack.mjs down` (stops every mode)
- status: `node factory-engine/bin/stack.mjs status --mode run`
Mode `run` is what the app's `.oracul/stack.json` declares for users (e.g. real providers); without that file both modes
are the plain docker-compose.yml. The factory's own E2E always uses mode `e2e`.

On success answer with:
```
Frontend  http://localhost:4200
Backend   http://localhost:8080/api   (health: http://localhost:8080/actuator/health)
Stop with: node factory-engine/bin/stack.mjs down
```
If it fails, show the log excerpt the script printed and the likely cause (Docker not running, port 4200/8080/5432 busy,
build error). Do not change app code from this skill, and never run `docker compose` or Playwright directly — only `stack.mjs`.
