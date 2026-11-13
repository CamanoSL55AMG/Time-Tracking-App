# Tested and approved — read this first

This is the list of Logbook features that **Art has tested and approved**.
It exists so nobody (a person or an AI session) spends time rebuilding, redesigning
or "improving" something that already works.

## Rules

1. **Read this file before you change any module.** Check the module's row.
2. **APPROVED means hands off.** It was tested by Art on the date shown and works.
   Don't rebuild, restyle, refactor or "clean up" it. Change it only when Art asks
   for that change in his own words. If you do change it, move its row to
   *Changed since approval* in the same PR and say what changed.
3. **Code flag.** Each approved file starts with a comment like
   `TESTED & APPROVED by Art 2026-11-12: <what>. See TESTED.md before changing.`
   Keep it. If a file is only partly approved, the comment says which part.
4. **Add a row when Art approves something.** Date, what, how it was tested,
   the code it covers, the PR. Only Art's own word ("works", "approved",
   a good test print, etc.) counts. A check by Claude alone goes under
   *Checked by Claude only*, never under Approved.
5. Newest first within each section.

## Approved by Art

| Date | What | How Art tested it | Code | PR |
|---|---|---|---|---|
| 2026-11-10 | Week page layout: big "Fix my times" button, larger rows and buttons, one help line, notes folded per day | Live on the Dell after the deploy; Art: "Logbook looks great now" | `client/src/pages/Week.tsx` (part: page layout) | #28 |
| 2026-11-07 | Forced password change: a person whose password an admin set gets the "Set your own password" screen at first sign-in | On the Dell with a test person after the deploy; Art: "both worked" (Logbook and AIC Accounting) | `client/src/pages/FirstPassword.tsx`, `server/src/auth/passwordChange.ts` | #23 |
| 2026-11-07 | Password generator (Bitwarden-style) and the per-person Password button in Manage > People | Tested by Art on the Dell after the deploy (Rollout Board: by Art, pass) | `client/src/passwordGen.ts`, `client/src/PasswordField.tsx`, `client/src/pages/Admin.tsx` (part: Password button and dialog) | #21 |
| 2026-11-07 | "New version" Reload card: big, centred, yellow Reload button, also checks when the window regains focus | Art saw the card on the Dell ("Card shows"), including on window focus | `client/src/components/NewVersionBanner.tsx` | #22, #17, #7 |
| 2026-11-01 | Bench Repair punch screen shows only bench work (no crew punch, no service items, no location notice) | Art checked it on his laptop before he merged it ("looks right") | `client/src/pages/Punch.tsx` (part: Bench Repair filters) | #3 |

## Being tested now

| Since | What | Waiting on | Code | PR |
|---|---|---|---|---|
| 2026-11-11 | Sales and Shop Supervisor roles | Art's test | `server/src/auth/apiKeys.ts`, `client/src/pages/Admin.tsx` (role list) | #35 |
| 2026-11-11 | Mark someone salaried (no weekly overtime) in Manage > People | Art marks the salaried people, then a payroll export check | `server/src/routes/people.ts`, `client/src/pages/Admin.tsx` | #33 |
| 2026-11-11 | Division admin: run the admin screens for one division only (Sound Services) | Kris's crew list, crew tagged with the division, then Kris signs in as division admin | `server/src/auth/division.ts`, `server/src/routes/people.ts`, `server/src/services/timesheets.ts` | #32 |
| 2026-11-11 | Send Sound Services shop punches to Stage Forge (switched off) | Switched on (`STAGEFORGE_PUNCH_PUSH`) and checked against Stage Forge | `server/src/services/stageforgePush.ts`, `server/src/routes/system.ts` | #34 |
| 2026-11-11 | Standard AICPNW logo in the top bar and the Set D Logbook icon | Art's look at the live header (Dell deploy done Nov 11); draft PR 31 changes the top bar again | `client/src/App.tsx`, `client/public/manifest.webmanifest` | #29 (with #24, #25) |
| 2026-11-10 | Techs fix their own times, then step through the day | First real fix by a tech and its review | `server/src/services/selfEdits.ts`, `server/src/services/requestRules.ts`, `client/src/pages/Week.tsx` (part: Fix my times) | #27 |
| 2026-11-10 | Old projects folded under Archived in the job lists | Art's test | `server/src/services/jobArchive.ts`, `client/src/pages/Punch.tsx`, `client/src/pages/Admin.tsx` | #26 |
| 2026-11-07 | First sign-in terms: Logbook privacy policy and EULA, then the AIC Platform Terms (gate off) | Attorney-approved text, then `TERMS_GATE_ENABLED` on go-live password reset day | `server/src/services/terms.ts`, `server/src/auth/termsGate.ts` | #12 |
| 2026-11-07 | Sick and vacation leave (turned on) | First real leave request; Gary's balances and vacation rates | `server/src/services/leave.ts`, `server/src/routes/leave.ts` | #20 |
| 2026-11-07 | Monthly repeating expenses | First monthly send of a real repeat | `server/src/services/recurringExpenses.ts`, `client/src/pages/RecurringExpenses.tsx` | #18 |
| 2026-11-07 | Expenses: search-only job box that keeps the pick on iPhone | A try on a real iPhone | `client/src/components/JobSearch.tsx` | #9 |
| 2026-11-07 | 1099 contractors: W-2 or 1099 per person, tagged in the payroll export (switched off) | A contractor bill in the AIC Accounting sandbox, then switched on | `server/src/services/workerType.ts`, `server/src/services/payroll.ts` | #19 |
| 2026-11-04 | Techs fix a missed clock-in or clock-out with a note; payroll can approve fixes | First real missed punch from the crew | `client/src/pages/Requests.tsx`, `server/src/services/requestRules.ts` | #10, #15 |
| 2026-11-04 | Payroll report screen, semimonthly pay periods, approve any time | Logbook go-live checks: approve a finished week, run the 1st to 15th report and match AIC Accounting | `client/src/pages/Payroll.tsx`, `server/src/services/timesheets.ts` | #11 |

## Changed since approval (needs a retest)

_None._

## Checked by Claude only (not yet approved by Art)

| Date | What | How it was checked | Code |
|---|---|---|---|
| 2026-11-13 | Location declined flag: each punch keeps whether the phone shared its position; declined punches show to approvers (row chip, week count with a filter, "Needs a look" list, "location declined" on the segment); the worker is told right after the punch (not on the Bench Repair screen) | Unit tests (`lib/geo.test.ts`, `lib/locationFlags.test.ts`) and the full smoke run on a local copy (254 checks pass). Not yet tried on a phone | `server/src/lib/geo.ts`, `server/src/lib/locationFlags.ts`, `server/src/services/exceptions.ts`, `client/src/api.ts` (readGeo), `client/src/pages/Punch.tsx` (NoLocationNotice), `client/src/pages/Review.tsx`, `client/src/pages/Week.tsx` (WeekDetail) |
| 2026-11-07 | AIC Terminal takes over Logbook app access and roles (people:roles key scope) | Dell journal after the 2 PM deploy: 26 people taken over from Logbook, the key has its scopes | `server/src/auth/apiKeys.ts`, `server/scripts/grant-ged-scopes.ts` |
| 2026-11-04 | On/off switch from AIC Control Tower (through Cloudflare Access) | Dell check after the deploy, tested both ways | `server/src/services/tower.ts` |
| 2026-11-04 | Payroll labor export to AIC Accounting | On the Dell: AIC Accounting's key read the Nov 1 to 15 labor feed | `server/src/services/payroll.ts`, `server/src/routes/payroll.ts` |

This list was started on 2026-11-12 from the task notes and the Rollout Board; older work that Art
approved may be missing. Add it when Art confirms it.
