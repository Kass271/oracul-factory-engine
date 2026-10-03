---
name: run
description: Start (or stop) the active Oracul app in Docker without rebuilding the factory flow, and print its URLs. Use when the user says "run the app", "start it", "stop the app".
---

# Run

From `oracul/`:
- start: `node factory-engine/bin/stack.mjs up` (builds images, waits for backend health + frontend)
- stop: `node factory-engine/bin/stack.mjs down`
- status: `node factory-engine/bin/stack.mjs status`

On success answer with:
```
Frontend  http://localhost:4200
Backend   http://localhost:8080/api   (health: http://localhost:8080/actuator/health)
Stop with: node factory-engine/bin/stack.mjs down
```
If it fails, show the log excerpt the script printed and the likely cause (Docker not running, port 4200/8080/5432 busy,
build error). Do not change app code from this skill.
