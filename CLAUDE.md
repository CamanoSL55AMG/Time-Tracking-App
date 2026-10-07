# CLAUDE.md — Time Tracking

Context for AI coding agents. The product plan is `TIME-TRACKING-APP.md`; read its
phases before adding features.

## Commands

```bash
cd server && npm run dev        # API, tsx watch on :5400 (needs Postgres and server/.env)
cd server && npm run typecheck
cd server && npm test           # unit tests (compiled, then node --test)
cd server && npm run smoke      # end-to-end against the running API
cd client && npm run dev        # Vite on :5195, proxies /api to :5400
cd client && npm run build      # tsc -b && vite build -> server/public
```

After any change to `server/prisma/schema.prisma`: `npx prisma db push` (same convention
as GED; do not use `prisma migrate dev`).

## Rules

1. Every endpoint is declared with `route()` from `server/src/api.ts`. That one
   declaration mounts the handler and feeds `/api/v1/openapi.json` and `/api/v1/docs`.
   Never add a bare `router.get(...)` for an API endpoint.
2. Errors are thrown as `ApiError` (`server/src/errors.ts`) and leave as
   `{ error: { code, message, details } }` with a real status. Never answer 200 on failure.
3. Every query filters by `companyId` from `req.auth`. Never trust a company id from the client.
4. Anything that changes a person's punches runs inside a transaction that first calls
   `lockPerson`, and reads "now" only after the lock is held. A person has at most one
   open segment and no overlapping segments.
5. Changes that other apps care about emit an event in the same transaction
   (`services/events.ts`).
6. A punch correction always needs a reason and writes a `PunchEdit`.
7. API keys are stored only as a SHA-256 hash. Secrets live in `server/.env`, never in the repo.
8. Breaking API changes go to `/api/v2`. v1 keeps working.
9. All client HTTP goes through `client/src/api.ts`.
10. When behaviour changes, add or update a check in `server/scripts/smoke.mjs`.
