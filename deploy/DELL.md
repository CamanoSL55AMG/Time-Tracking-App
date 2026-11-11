# Logbook on the Dell (shop server)

Runs like Project Report and AV Inventory: a checkout in `~/apps/time-tracking`, a
`logbook` systemd service on port **5400** (app + API on one port), its own Postgres
database `timetracking`, a daily auto-deploy from GitHub `main` at 14:30, and a nightly
dump into `/var/backups/pg/<date>/timetracking.dump` (pulled by `pull-dell-backups.ps1`).

## First install

```bash
ssh aicnw@10.0.20.20
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/CamanoSL55AMG/Time-Tracking-App.git time-tracking
cd time-tracking
bash deploy/install-service.sh        # creates the database + server/.env, then stops
nano server/.env                   # fill ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (10+ chars)
bash deploy/install-service.sh        # service, backup, daily deploy
bash deploy/deploy.sh main --force     # install, build, start
```

Check: `curl http://localhost:5400/api/v1/health`, then open `http://10.0.20.20:5400`
on the office network and sign in as the admin.

## Public address (phones)

Phones only share location over HTTPS, so add a hostname on the Cloudflare tunnel the
same way as the other apps, pointing at `http://localhost:5400`. Put that address in
`APP_URL` in `server/.env` and `sudo systemctl restart logbook`. For "Sign in with
Google", set `GOOGLE_CLIENT_ID` and add the address to the client's Authorized
JavaScript origins.

## Forgot password email

"Forgot password?" on the sign-in page emails a one-time link. Add the same Gmail pair
GED uses to `server/.env` (copy the two lines from GED's `server/.env`), check `APP_URL`
is the public HTTPS address, then `sudo systemctl restart logbook`:

```
GMAIL_USER=
GMAIL_APP_PASSWORD=
```

Without them the page still answers normally, nothing is sent, and
`journalctl -u logbook` shows a warning each time it is used.

## Control Tower switch

Logbook can be turned on and off per company in AIC Control Tower (Manifest → Logbook).
To have this Dell honour it, add to `server/.env`:

```
TOWER_URL=https://tower.aicpnw.com
TOWER_TOKEN=<the same TOWER_TOKEN as /etc/ged-health-check.conf>
```

The Tower is behind Cloudflare Access, so Logbook also needs the health check's
service-token pair. Copy it across without printing it:

```
sudo grep '^TOWER_ACCESS_' /etc/ged-health-check.conf >> ~/apps/time-tracking/server/.env
```

then `sudo systemctl restart logbook` and check
`curl -s http://localhost:5400/api/v1/health` shows `"source":"tower"`. Without the two
lines, or with the Tower unreachable, Logbook stays ON; `"detail"` in the health answer
says why (a 302 means the Access pair is missing or wrong).

## Day to day

- Changes reach the Dell by pushing to `main` (Github-save); the 14:30 job deploys them.
  To deploy right away: `~/apps/time-tracking/deploy/deploy.sh main --force`.
- Logs: `journalctl -u logbook -n 100` and `deploy/deploy.log`.
- `db push` stops instead of dropping data; if a deploy stops there, look before forcing.
