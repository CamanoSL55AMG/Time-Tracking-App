# Logbook (Time Tracking)

Logbook, the AIC Terminal time tracking module. Standalone time tracking: a phone-first punch clock that records the job and the phase
of the day, a live Tower board, and a versioned API that other apps (GED, Project Report,
Accounting) link to. Built to replace Timesheets.com at Morgan Sound and to be sold on
its own. The full plan is in [TIME-TRACKING-APP.md](TIME-TRACKING-APP.md).

```
client/   React + TypeScript + MUI (Vite) — the app techs use on their phones   :5195 in dev
server/   Express + TypeScript + Prisma + PostgreSQL — the API at /api/v1        :5400
```

## What works today

- Sign-in by email and password, and one-click sign-in from GED (`/sso?token=…`).
- **Sign in with Dashboard**: GED is the sign-in service for every add-on
  (`DASHBOARD-SIGN-IN.md` in the GED repo). Set up with GED's `npm run oidc:client`.
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
- **My week**: each person sees their week by day and signs it. Wrong time or a
  forgotten punch? They ask for a change (or add missing time) right there; nothing
  counts until a supervisor approves it, and the approved change is kept in the
  segment's history with who asked, who approved and why.
- **Review**: managers and payroll see everyone's week, the problems to look at (missed
  clock-outs, days over 12 hours, punches away from the site, corrections, punches sent
  late), the change requests waiting for a decision, correct segments, and approve. An
  approved week is locked until reopened, and a week with a change still waiting
  cannot be approved.
- **Crew punch**: a lead's Clock In / Next / Clock Out can punch the whole crew too.

- **Start screen: Install, Service, Office, Shop.** Each mode offers its own phases and
  jobs first. Office and Shop are a master clock: one clock-in, one-tap project and task
  switching, **Stop project** onto unallocated / overhead time, **Back to …** after a break,
  and a colour bar of the day. Service is Start drive → Arrived → Call complete → next call.
- **Service billing** (Review screen and `/reports/service-billing`): 0.5 h travel per call,
  first hour on site in the trip charge, then 15-minute steps. Settings under Manage.

- **CAD mode**: a project plus a CAD task (Design, Signal flow / line diagrams, Floor
  plans, Rack elevations, Submittals, Cable schedules, Revisions, As-builts, Plotting).
- **Open items**: a Service ticket, or a Shop / Office / CAD task, stays open when the
  person switches to other work; "Your open items" on the clock screen has **Resume**.
  **Notes** at the top of the picker go on the item. Clocking out asks "Taking a break"
  (items stay open) or "Done for the day" (close each with what was done, or leave it
  open with a reason). Call complete asks the same for the service ticket. The office
  sees everyone's open items on Review (`GET /items`).

- **Expenses**: "+ Expense on this flight" charges a line to the job you are clocked
  into; the Expenses tab adds lines on their own (any job or none), with receipt photos,
  mileage at the company rate, and approval on the Review screen.

Not built yet: expense export, pay periods and the payroll export, leave, kiosk mode,
webhooks. See the phases in the plan.

## First-time setup (Windows)

Needs Node 20 or newer and a PostgreSQL you can reach. The same Postgres that GED uses is
fine; this app keeps its own database (`timetracking`).

```powershell
cd server
copy .env.example .env      # then fill in DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
npm install
npx prisma db push          # creates the database and tables
npm run seed                # company, first admin, the phases of every mode, Shop, Service call and overhead jobs

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
npm run smoke   # with the API running: end-to-end checks against your database
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
