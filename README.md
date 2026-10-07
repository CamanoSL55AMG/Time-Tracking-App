# Time Tracking

Standalone time tracking app: punch clock with job and phase-of-day, Tower board,
expenses, leave, payroll export, and a versioned API other apps link to.
Built to replace Timesheets.com at Morgan Sound and to be sold on its own.

The full plan is in [TIME-TRACKING-APP.md](TIME-TRACKING-APP.md).

## Layout

```
client/   React + TypeScript + MUI (Vite) — phone-first app
server/   Express + TypeScript + Prisma — API at /api/v1
```
