# Time Tracking

Standalone time tracking: a phone-first punch clock that records the job and the phase
of the day, a live Tower board, and a versioned API that other apps (GED, Project Report,
Accounting) link to. Built to replace Timesheets.com at Morgan Sound and to be sold on
its own. The full plan is in [TIME-TRACKING-APP.md](TIME-TRACKING-APP.md).

```
client/   React + TypeScript + MUI (Vite) — the app techs use on their phones   :5195 in dev
server/   Express + TypeScript + Prisma + PostgreSQL — the API at /api/v1        :5400
```

## What works today

- Sign-in by email and password, and one-click sign-in from GED (`/sso?token=…`).
- Clock in, Next phase, Switch job, Clock out. Each punch is stamped with the phone's
  location at that moment.
- The seven phases of the day, from "Shop — load vans" to "Shop — unload / put away".
- Tower board: who is on the clock, which job, which phase, since when.
- Corrections with a required reason and a full edit history.
- People, jobs and integration keys managed in the app.
- API: scoped keys, `X-Act-As`, `Idempotency-Key`, change feed, hours report, and a
  reference page at `/api/v1/docs` generated from the code.

- Today's job calendar assignment offered first and pre-selected (pushed in by GED).
- No signal? Punches are kept on the phone with the time they were tapped and sent, in
  order, when the signal returns.

Not built yet: crew punch, approvals, expenses, payroll export, leave. See the phases in
the plan.

## First-time setup (Windows)

Needs Node 20 or newer and a PostgreSQL you can reach. The same Postgres that GED uses is
fine; this app keeps its own database (`timetracking`).

```powershell
cd server
copy .env.example .env      # then fill in DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
npm install
npx prisma db push          # creates the database and tables
npm run seed                # company, first admin, the phases, Shop and Service call jobs

cd ..\client
npm install
```

Or run `setup.cmd` from the repo root after filling in `server\.env`.

To let people arrive signed in from GED, set `ADDON_SSO_SECRET` to the same value GED has.

## Ports

API 5400, app 5195 in development. Chosen to stay clear of the other apps on the same PC
(GED 5000/5173, AV Inventory 3001/5174, Project Report 5200/5180, Control Tower 5300/5190,
Standalone 5500/5175).

## Running

```powershell
dev-api.cmd     # API on http://localhost:5400   (reference: http://localhost:5400/api/v1/docs)
dev-web.cmd     # app on http://localhost:5195
```

For one server that serves both the app and the API on :5400, run `build.bat`, then
`npm start` in `server`.

Phones only share their location with pages loaded over HTTPS, so for real use put the
app behind the Cloudflare tunnel the same way as the other apps.

## Checking it

```powershell
cd server
npm test        # unit tests: time zones, geofence, sign-in tokens, keys
npm run smoke   # with the API running: 45 end-to-end checks against your database
```

`npm run smoke` creates a throwaway person and job, walks a whole day of punches through
the API, and deactivates them again when it is done.

## Linking GED

```powershell
cd server
npm run link-ged      # creates GED's key and writes it into GED's server\.env
```

Then restart GED's server. GED pushes its active projects as jobs and today's job
calendar as assignments, and its title-bar clock punches through this app.

## Linking another app

1. In the app: Manage → API keys → Create key. Tick only the scopes that app needs. Copy
   the key; it is shown once.
2. Send it as `Authorization: Bearer tt_live_…`.
3. To punch for someone, add `X-Act-As: their@email` (needs `punch:write:any`).

```bash
# Keep a GED project selectable as a job
curl -X PUT http://localhost:5400/api/v1/jobs/by-ref/ged/P-1371 \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"P-1371 Canyon Hill","code":"P-1371","kind":"project"}'

# Clock a tech in to it from a task button
curl -X POST http://localhost:5400/api/v1/punches/in \
  -H "Authorization: Bearer $KEY" -H "X-Act-As: tech@morgansound.com" \
  -H "Content-Type: application/json" \
  -d '{"jobRef":{"system":"ged","externalId":"P-1371"},"phaseKey":"work"}'
```
