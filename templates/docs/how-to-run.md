# How to run — {{APP_TITLE}}

## Start
```bash
cd apps/{{APP_NAME}}
docker compose up -d --build
```
- Frontend: http://localhost:4200
- Backend API: http://localhost:8080/api · health: http://localhost:8080/actuator/health

## Stop
```bash
docker compose down        # keep data
docker compose down -v     # wipe the database
```

## Test users / seed data
- …
