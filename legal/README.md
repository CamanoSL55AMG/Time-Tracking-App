# Legal documents (first sign-in terms)

The documents a person must accept before they can use Logbook, in the order shown:

1. `logbook-privacy.md` — Logbook Privacy Policy
2. `logbook-eula.md` — Logbook End User License Agreement
3. `aic-platform-terms.md` — AIC Platform Terms (the same file, byte for byte, in every AIC app; always last)

`manifest.json` lists them: id, title, kind (`privacy` | `eula` | `global`), version and
file. The order in the manifest is the order people see them.

The screen is off until `TERMS_GATE_ENABLED=true` is set in `server/.env`.

## Updating a document

1. Replace the text in its `.md` file with the approved text (plain Markdown: headings,
   paragraphs, **bold**, lists).
2. Change its `"version"` in `manifest.json` (e.g. `2027-01-15`).
3. Restart the server. It reads this folder once at start.

Everyone is asked to accept that document again, on their own screen, the next time
they use the app. Documents whose version did not change are not asked again.

For `aic-platform-terms.md`, make the same change in every AIC app's repo so the file
stays identical everywhere.

## Where acceptances are kept

Table `terms_acceptance` in the Logbook database: who (`userId`, the person id), which
document and version, the SHA-256 of the exact file text they saw, when, and their IP
address and browser. Rows are only ever added.

```sql
SELECT p.email, t."documentId", t.version, t."acceptedAt", t.ip
FROM terms_acceptance t JOIN "Person" p ON p.id = t."userId"
ORDER BY t."acceptedAt" DESC;
```
