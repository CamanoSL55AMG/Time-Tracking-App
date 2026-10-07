# Time Tracking — Standalone App Spec

**Status:** Draft 4; Phase 0 and the core of Phase 1 built 2026-10-07 (see README) · **Date:** 2026-10-07 · **Author:** Art Howard + Claude
**Supersedes:** the GED-embedded punch clock built 2026-10-05 (code to be moved here, see §11)

## 1. Decision

Time tracking becomes its own app, alongside AV Inventory, Project Report and Accounting.
GED stops owning punches. GED, Project Report, Accounting and anything else link to this
app through one versioned API (§6).

Reasons:

- Sellable on its own to a company that does not run GED.
- Techs get a phone-first app with a handful of taps, not the PM dashboard.
- Hours and GPS stamps live in their own database with their own access and backup.
- Same pattern Project Report followed when it left GED on 2026-09-28.

## 2. Goals and non-goals

Goals

1. Replace Timesheets.com for Morgan Sound: punch, review, approve, export to payroll.
2. Capture hours by **job** and by **phase of the day**, so bid-vs-actual labor is a query.
3. A linking API good enough that every other app reads and writes time through it, and
   that a customer's own developer could use without calling us.
4. Run in parallel with Timesheets.com until the hours reconcile, then cut over.
5. Track **leave** per person: Washington paid sick leave accrual, vacation, PTO, and
   Washington Paid Family and Medical Leave (§7).
6. Track **expenses and mileage** against jobs, with receipts and approval (§8).

Non-goals

- Payroll itself (taxes, pay runs, premium withholding). We hand clean hours, leave and
  reimbursements to the payroll/accounting system.
- Scheduling. The shared Google Calendar stays the schedule; we only read it.
- Invoicing and billable-rate management.

## 3. Timesheets.com as the baseline

Their public feature list (timesheets.com/features, read 2026-10-07) and their Public API
v1 (documented in GED's `TIME-TRACKING-MODULE.md`) tell us what a complete product in this
category covers. We use that as a checklist of *what* to cover. The *how* comes from Morgan
Sound's own workday.

| Their feature area | Ours | Phase |
| --- | --- | --- |
| Hourly time clock (in / out / break) | Punch segments, open segment = on the clock | 1 |
| Project time (customer / project / account code) | Job + phase on every segment | 1 |
| Mobile punch with GPS, geofence, photo ID | Phone PWA, GPS stamp at each punch, shop + site geofence. No photo ID | 1 (GPS), 2 (site fences) |
| Shared-device kiosk | Shop tablet mode: pick your name, PIN, punch | 2 |
| Approvals / signing | Tech signs the week, lead or PM approves | 2 |
| Payroll-ready export, payroll periods | Pay periods, locked on export, AccountEdge file first | 4 |
| QuickBooks / Gusto integrations | Export adapters behind one interface; Accounting app reads the API | 4+ |
| Record history / audit | Every edit kept: who, when, before, after, reason | 1 |
| Overlap and alert reports | Overlap, missed punch, long shift, punch away from job site | 2 |
| Time off and PTO accruals | Ledger-based leave: WA sick, vacation, PTO, family leave, requests and approval (§7) | 5 |
| Mileage and expenses | Expenses, mileage, receipts, approval, job costing (§8) | 3 |
| Scheduling | Not built. Read-only from Google Calendar | — |
| HR documents and acknowledgments | Not built | — |
| Public API | Core of the product, see §6 | 1 |

Keeping it our own work: we take no code, screens, wording, icons or help text from them,
and we do not reuse their API's shapes or field names in ours. Feature *categories* such as
"clock in" or "approve a timesheet" are common to every product of this kind. If this is
sold commercially, have counsel look at the name and marketing before launch.

## 4. What we do that they do not

- **Phases of the day.** Shop load → Drive to site → Unload → Work → Clean up → Drive to
  shop → Shop put-away. One tap on "Next" closes a segment and opens the next on the same
  job. The phase list is configurable per company.
- **Job pre-filled from the calendar.** Today's entry on the shared Morgan Sound calendar
  (crew initials in the title) selects the job before the tech touches anything.
- **One-click punch from other apps.** A task card in GED can clock a tech into that job
  with one API call.
- **Tower board.** Live view of every tech: job, phase n of 7, since when, hours today.
- **Labor budget tie-in.** Hours per job per phase line up against the labor sold in
  Jetbuilt, through GED.
- **Lead punches the crew.** One action clocks several people onto the same job.

## 5. Architecture

Same stack as Project Report so there is nothing new to learn or deploy.

```
client/   React + TypeScript + MUI (Vite), installable PWA, phone-first, works offline
server/   Express + TypeScript + Prisma
db        PostgreSQL, its own database (name: timetracking)
deploy    Dockerfile + docker-compose, same as the other add-ons
```

- **Offline.** Punches queue on the phone with their real timestamp and a client-generated
  id, and sync when signal returns. The server accepts the same id twice without
  duplicating (see idempotency, §6.2).
- **Tenancy.** Every table carries `companyId` from day one. One company per install today;
  a shared cloud install later needs no schema change.
- **Sign-in.** Three ways: GED one-click (the existing `v1.<payload>.<hmac>` add-on token,
  audience `time_tracking`), the app's own email + password for companies without GED, and
  name + PIN in kiosk mode.
- **Roles.** `tech`, `lead`, `manager`, `payroll`, `admin`.
- **GPS.** A position is recorded only at the moment of a punch. No background tracking.
  Staff are told this in writing before rollout.

### Data model (sketch)

| Table | Purpose | Key fields |
| --- | --- | --- |
| Company | Tenant | name, timezone, weekStart, payPeriodRule |
| Person | Anyone who punches or approves | email, name, initials, role, pin, active |
| Job | Something hours are charged to | kind (project / service / shop / other), name, code, active, siteLat, siteLng, siteRadiusM |
| Phase | Task picker entries | name, short, sortOrder, atShop, active |
| Punch | One segment of work | personId, jobId, phaseId, clockIn, clockOut, source, in/out lat-lng-accuracy, notes, clientId |
| PunchEdit | Audit trail | punchId, editedBy, at, before, after, reason |
| PayPeriod | Payroll window | start, end, status (open / locked / exported) |
| Approval | Sign-off | personId, payPeriodId or week, signedAt, approvedBy, approvedAt |
| LeaveType | Kinds of leave | name, paid, drawsBalance, statutory (wa_sick / wa_pfml / none) |
| LeavePolicy | Accrual rules | leaveTypeId, method (per hours worked / per period / annual grant), rate, cap, carryoverMax, waitingDays, tiers by years of service |
| PersonLeavePolicy | Which policy applies to whom | personId, leavePolicyId, effectiveFrom, effectiveTo |
| LeaveLedger | Every change to a balance | personId, leaveTypeId, kind (accrual / use / adjustment / carryover / forfeit / payout / reinstate), hours, at, sourceRef, note |
| LeaveRequest | Time-off requests | personId, leaveTypeId, start, end, hours, status, decidedBy, decidedAt |
| Expense | One expense or mileage line | personId, jobId, date, categoryId, amount, miles, rate, paidBy (employee / company card), vendor, receiptFileId, notes |
| ExpenseReport | A submitted batch | personId, status (draft / submitted / approved / rejected / exported), approvedBy |
| ExpenseCategory, MileageRate | Lookups | name, accountCode / ratePerMile, effectiveFrom |
| ExternalRef | Ids in other systems | entity, entityId, system (ged / jetbuilt / timesheets / accountedge), externalId |
| ApiKey | Integration credentials | name, hashedKey, scopes, lastUsedAt, revokedAt |
| Webhook | Outbound subscriptions | url, secret, events, active |
| Event | Change feed + webhook source | seq, type, payload, at |

`ExternalRef` is what makes linking dependable: a GED project, a Jetbuilt P-number and a
Timesheets project id can all point at the same Job without any of them being its key.

## 6. Linking API

Design target: another app, or a customer's developer, can integrate using only the
published document.

### 6.1 Conventions

- Base path `/api/v1`. Breaking changes go to `/api/v2`; v1 keeps working.
- Machine-readable description served at `/api/v1/openapi.json`, with a browsable page at
  `/api/v1/docs`. The spec is generated from the route definitions so it cannot drift.
- JSON in and out. Times are ISO 8601 in UTC; the company timezone is on `Company`.
- Errors use real HTTP status codes with one body shape:
  `{ "error": { "code": "punch_overlap", "message": "…", "details": {…} } }`.
  A failed request never returns 200.
- Lists are cursor-paginated: `?limit=100&cursor=…` → `{ data, nextCursor }`.
- Every list accepts `updatedSince` for incremental sync.
- Rate limits are per key and reported in `RateLimit-*` response headers.

### 6.2 Authentication and safety

| Caller | Credential | Notes |
| --- | --- | --- |
| A person in the app | Session cookie / JWT | From password, PIN, or GED one-click token |
| Another app (GED, Project Report, Accounting) | `Authorization: Bearer tt_live_…` | One key per integration, stored hashed, revocable, with scopes |
| App acting for a person | API key + `X-Act-As: person@company.com` | Needs the `punch:write:any` scope; the audit trail records both the key and the person |

Scopes: `punch:read`, `punch:write:any`, `jobs:read`, `jobs:write`, `people:read`,
`people:write`, `reports:read`, `payroll:read`, `payroll:export`, `leave:read`,
`leave:write`, `leave:approve`, `expenses:read`, `expenses:write`, `expenses:approve`,
`webhooks:manage`.

Idempotency: every POST accepts an `Idempotency-Key` header. Repeating a request with the
same key returns the original result. This is what makes offline sync and retried
one-click punches safe.

### 6.3 Endpoints

Punching

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/me/state` | On/off the clock, open segment, today's segments, next phase |
| POST | `/punches/in` | Clock in, or switch job if already on the clock. Body: job, phase, geo, at |
| POST | `/punches/next` | Next phase on the same job |
| POST | `/punches/out` | Clock out |
| POST | `/punches/crew` | Lead clocks several people in, out, or to the next phase |
| POST | `/punches/sync` | Batch upload of offline punches |
| GET | `/punches` | Filter by person, job, phase, date range, updatedSince |
| GET | `/punches/{id}` | One segment with its edit history |
| PATCH | `/punches/{id}` | Correct a segment. Reason required; writes a PunchEdit |
| POST | `/punches` | Add a missed segment after the fact. Reason required |

Reference data

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/jobs` | Jobs, filter by kind / active / search |
| PUT | `/jobs/by-ref/{system}/{externalId}` | Create or update a job by its id in another system. GED uses this to keep active Jetbuilt projects and service calls selectable |
| GET, PUT | `/phases` | The phase list |
| GET | `/people` | Roster |
| PUT | `/people/by-email/{email}` | Create or update a person from another app |
| GET | `/me/suggested-jobs` | Today's calendar assignment first, then recent jobs |

Views and reports

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/board` | Tower: everyone's current job and phase |
| GET | `/reports/hours` | Hours grouped by any of person / job / phase / day / week |
| GET | `/reports/exceptions` | Overlaps, missed punches, long shifts, off-site punches |
| GET | `/reports/reconcile` | Our hours vs Timesheets.com per person per day (parallel run only) |

Payroll

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/pay-periods` | Periods and their status |
| POST | `/pay-periods/{id}/lock` | Freeze a period |
| GET | `/pay-periods/{id}/export?format=accountedge` | Payroll file. Marks the period exported |
| POST | `/approvals/sign`, `/approvals/approve` | Tech signs, manager approves |

Leave

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/leave/types`, `/leave/policies` | What leave exists and how it accrues |
| PUT | `/people/{id}/leave/policies` | Assign policies to a person |
| GET | `/people/{id}/leave/balances` | Current balance per leave type |
| GET | `/leave/ledger` | Every accrual, use and adjustment, filterable |
| POST | `/leave/requests` | Request time off |
| POST | `/leave/requests/{id}/approve`, `/deny`, `/cancel` | Decide or withdraw a request |
| POST | `/leave/adjustments` | Manual correction or opening balance. Reason required |
| GET | `/leave/statements?month=` | Monthly earned / used / available statement per person |
| GET | `/reports/pfml-quarterly?year=&quarter=` | Hours per person for the state quarterly report |

Expenses

| Method | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/expenses` | List or add an expense or mileage line |
| PATCH, DELETE | `/expenses/{id}` | Change or remove while still in draft |
| POST | `/expenses/{id}/receipt` | Upload the receipt photo |
| POST | `/expense-reports/{id}/submit`, `/approve`, `/reject` | Workflow |
| GET | `/expense-categories`, `/mileage-rates` | Lookups |
| GET | `/reports/expenses` | Totals by job / person / category / period |

Integration plumbing

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/events?after={seq}` | Ordered change feed. For callers that poll |
| GET, POST, DELETE | `/webhooks` | Manage outbound subscriptions |
| GET | `/health` | Liveness, no auth |

### 6.4 Events

Types: `punch.started`, `punch.ended`, `punch.switched`, `punch.edited`, `punch.deleted`,
`job.upserted`, `person.upserted`, `period.locked`, `period.exported`,
`approval.signed`, `approval.approved`, `leave.requested`, `leave.approved`,
`leave.denied`, `leave.accrued`, `expense.submitted`, `expense.approved`,
`expense.exported`.

Two ways to receive them, same payloads:

- **Webhooks**, for apps that accept inbound calls. Each delivery is signed
  (`X-TT-Signature: sha256=…` over the raw body with the subscription secret), carries an
  event id for de-duplication, and is retried with backoff for 24 hours.
- **Event feed**, for apps that do not. GED has a standing rule that nothing calls into it,
  so GED polls `/events?after=…` and remembers the last sequence number it processed.

### 6.5 How each app links

| App | Direction | What it does |
| --- | --- | --- |
| GED | GED → Time | Pushes jobs (`PUT /jobs/by-ref/ged/…`). Title-bar clock and task buttons call the punch endpoints with `X-Act-As`. Budget-vs-actual pages read `/reports/hours`. Polls `/events` |
| Project Report | Report → Time | Reads `/reports/hours` and `/punches` instead of Timesheets.com after cutover |
| Accounting | Accounting → Time | Reads locked pay periods, leave taken, approved expenses and reimbursements |
| AIC Control Tower | Tower → Time | Turns the module on per company, issues the first admin and API key |
| Google Calendar | Time → Google | Reads the shared calendar through one office connection |
| Timesheets.com | Time → Timesheets | Read-only: seed people, tasks and projects; pull hours for the reconcile report |

## 7. Leave

### 7.1 How balances work

Balances are never stored as a single number that gets overwritten. Every change is a row
in `LeaveLedger` and the balance is the sum. Any balance can be explained line by line,
which is what an employee or an auditor will ask for.

Accruals that depend on hours worked are calculated from the punches when a pay period
locks. Approved leave appears on the timesheet as leave hours, shows on the Tower board as
"off", and flows into the payroll export.

### 7.2 Washington paid sick leave

Built in as a preset policy. Rules as published by L&I
(lni.wa.gov/workers-rights/leave/paid-sick-leave, read 2026-10-07):

| Rule | What the app does |
| --- | --- |
| At least 1 hour for every 40 hours worked, for every employee including part-time, temporary and seasonal | Accrues from punched hours at pay-period lock. Rate can be raised, not lowered |
| Usable from the 90th calendar day after start | Blocks requests before that date and shows the date |
| Unused balance of 40 hours or less carries over to the next year | Year-end carryover entry. Cap can be raised |
| Paid at normal hourly compensation, in the pay period it was used | Leave hours go into that period's export |
| Statement at least monthly: earned, used, available | Generates it per person, in the app and by email, and keeps a copy |
| One-time written notice of rights at hire | Records that the notice was shown and acknowledged |
| Balance reinstated if rehired within 12 months, unless paid out | `reinstate` ledger entry on rehire |
| Verification only for absences over 3 days, and only with a written policy | Optional flag on requests longer than 3 days |
| Certain construction-industry workers must be paid their balance at separation | Does not apply to Morgan Sound (decided 2026-10-07). Payout stays available as a per-company setting, off by default |

Permitted reasons include the employee's or a family member's health, public-health
closures, domestic violence leave, and (since 2025-07-27) immigration proceedings. The app
does **not** ask for or store a reason beyond "sick leave". Medical detail stays out of it.

To confirm with payroll before go-live: the exact definition of "hours worked" for accrual
(overtime, travel, paid leave hours).

### 7.3 Vacation and PTO

- Morgan Sound keeps **separate banks**: sick leave and vacation are different leave types
  with their own balances (decided 2026-10-07).
- A policy is assigned **per person**, with an effective date, so two people can have
  different arrangements.
- Accrual methods: per hour worked, a fixed amount per pay period, or a grant on a set date
  or work anniversary. Optional tiers by years of service, a balance cap, and a carryover
  limit.
- **Opening balances** come from the finance spreadsheet that holds sick and vacation
  balances today. Phase 5 includes an import: upload the sheet (xlsx or csv), match each row
  to a person, preview, then post one `adjustment` ledger entry per person per leave type,
  dated the switchover day. The spreadsheet and the app run side by side for one month and
  are compared before the spreadsheet is retired.
- A combined PTO bank remains a per-company option for other customers. Such a bank has to
  meet every sick-leave rule above, and the preset enforces that.
- Other types (holiday, bereavement, jury duty, unpaid) are leave types with no accrual.

### 7.4 Washington Paid Family and Medical Leave

This is a state insurance program, not an employer-kept balance. Per paidleave.wa.gov
(read 2026-10-07): the employee applies to the state, the state notifies the employer of
the start and end dates, and employers of every size report each employee's wages and
hours every quarter and collect premiums. Employers with fewer than 50 employees are not
required to pay the employer share.

What the app does:

- Records the leave period as a `wa_pfml` leave type so the person shows as on leave and
  nobody expects punches. It draws no balance unless the company chooses to top up from
  PTO.
- Produces hours per person per quarter for the state report (`/reports/pfml-quarterly`).
- Premium calculation and withholding stay with payroll. The rate changes yearly.

### 7.5 Requests

Tech requests leave on the phone → lead or manager approves → hours land on the timesheet
and in the ledger. Optionally the app adds the entry to the shared calendar in the office's
existing style ("TB OFF"), so the schedule and the leave record agree.

## 8. Expenses

- **Entry on the phone:** amount, date, category, job, vendor, who paid (employee, to be
  reimbursed, or company card), a photo of the receipt, a note.
- **Mileage:** miles × the rate in force on that date. Rates are a table an admin
  maintains; nothing is hard-coded.
- **Workflow:** draft → submitted → approved or rejected → exported. Approved lines lock.
- **Job costing:** every line carries a job, so expenses per job are available to GED next
  to labor.
- **Out the door:** reimbursable totals per person go to payroll or accounts payable;
  company-card lines go to accounting with their category's account code.
- **Receipts** are stored with the record and backed up with the database.

## 9. Parallel run and cutover

1. **Seed.** Import people, account codes and projects from Timesheets.com so nobody
   re-keys anything. Map each to an `ExternalRef`.
2. **Parallel.** Techs punch here; the app then opens Timesheets.com so they mirror the
   punch there. Their API cannot accept a punch, so this step is manual. Timesheets.com
   stays the payroll source.
3. **Reconcile.** `/reports/reconcile` shows our hours against theirs per person per day.
4. **Cut over** when the difference is zero, or explained, for two full pay periods.
   Morgan Sound uses Timesheets.com for time and for expenses, so both must be live here
   first. Leave is not kept there, so it does not hold up the cutover.
   Payroll switches to our export. Timesheets.com goes read-only, then is cancelled.
5. **History.** Optionally import past Timesheets.com entries as closed segments so reports
   reach back before the cutover.

## 10. Phases

| Phase | Delivers |
| --- | --- |
| 0 — Scaffold | New repo, database, sign-in (GED token + password), API skeleton with keys, scopes, OpenAPI page |
| 1 — Punch | Phone punch screen, phases, calendar pre-fill, GPS stamp, offline queue, edit with audit, Tower board, events feed. GED clock becomes a thin client |
| 2 — Review | Exceptions report, sign and approve, crew punch, kiosk mode, site geofences, webhooks, reconcile report |
| 3 — Expenses | Expenses, mileage, receipts, approval, export. Needed before cutover because expenses run through Timesheets.com today |
| 4 — Payroll | Pay periods, lock, AccountEdge export, rounding / overtime / break rules, state quarterly hours report. **Cutover happens here** |
| 5 — Leave | Leave ledger, WA sick leave preset, separate per-person vacation policies, requests and approval, monthly statements, family-leave periods, leave hours in the payroll export |
| 6 — Later | More export formats, history import, kiosk photo |

Rounding, overtime, break and leave rules are legal requirements, not design choices.
They must be confirmed with whoever runs payroll, and the leave rules with L&I guidance or
counsel, before Phases 4 and 5 are built.

## 11. What already exists

Built inside GED on 2026-10-05, uncommitted on `main` in
`C:\Users\art\Source\Repos\google-ecosystem-dashboard`. All of it moves here in Phase 0–1.

| GED file | Becomes |
| --- | --- |
| `server/prisma/schema.prisma` → `model Punch` | Starting point for `Punch` (add companyId, jobId, phaseId, clientId) |
| `server/src/services/punch.ts` | Punch in / out / switch / next, phases, shop geofence, board, reconcile |
| `server/src/routes/punch.ts` | Basis for the `/api/v1/punches` routes |
| `client/src/features/time/hooks/usePunch.ts` | Client hook, including the geolocation grab |
| `client/src/features/time/components/PunchBoard.tsx` | Tower board |
| `client/src/features/time/components/ClockButton.tsx`, `PunchToJobButton.tsx` | Stay in GED, rewired to call this app's API |

GED keeps: the calendar-title parsing (`eventsForStaff`, `crewFromTitle`), which is copied
here; the Jetbuilt labor budget; and the budget-vs-actual pages. GED's `Punch` table is
dropped once the clock points at this app. No real punches exist in it.

## 12. Open decisions

1. **Name** of the app and its repo folder (working name: `time-tracking`).
2. **Where it runs first:** the Dell beside the other add-ons, or the cloud Linux host.
3. **Tech sign-in on phones:** GED accounts for everyone, or this app's own logins.
4. **Pay period definition** and the overtime / rounding / break rules.
5. **Payroll export format:** AccountEdge timesheets or activity slips.
6. **History:** import past Timesheets.com entries or start clean at cutover.
7. **Photo at punch and kiosk mode:** wanted, or leave out.
8. **Vacation rules per person:** accrual rate, cap, carryover, anniversary or calendar year.
9. **Expense categories** and which account codes they map to.

Decided 2026-10-07

- Timesheets.com is used today for time tracking and expenses only.
- The construction-worker sick-leave payout rule does not apply to Morgan Sound.
- Sick leave and vacation are separate banks.
- Sick and vacation balances are kept today in a spreadsheet maintained by Gary (finance).
