#!/usr/bin/env bash
# One-time on the shop server (the Dell): database + .env + systemd unit +
# nightly backup + daily deploy cron. Safe to re-run. From the checkout:
#   ~/apps/time-tracking/deploy/install-service.sh [branch] [HH:MM]
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"; AT="${2:-14:30}"; HH="${AT%%:*}"; MM="${AT##*:}"
ME="$(id -un)"
ENVF="$APP/server/.env"
DB=timetracking; ROLE=timetracking

command -v node >/dev/null || { echo "Node is not installed (need 20+)"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node $(node -v) is too old — need 20+"; exit 1; }

echo "== database: $DB (its own role, separate from GED / AV Inventory)"
if [ ! -f "$ENVF" ]; then
  DB_PW=$(openssl rand -hex 16)
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$ROLE'" | grep -q 1; then
    sudo -u postgres psql -qc "ALTER ROLE $ROLE WITH LOGIN PASSWORD '$DB_PW';"
  else
    sudo -u postgres psql -qc "CREATE ROLE $ROLE WITH LOGIN PASSWORD '$DB_PW';"
  fi
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || sudo -u postgres psql -qc "CREATE DATABASE $DB OWNER $ROLE;"
  JWT=$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-64)
  cp "$APP/server/.env.example" "$ENVF"
  sed -i \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://$ROLE:$DB_PW@127.0.0.1:5432/$DB#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=$JWT#" \
    -e "s#^CORS_ORIGINS=.*#CORS_ORIGINS=#" \
    -e "s#^APP_URL=.*#APP_URL=${APP_URL:-https://logbook.morgansound-dev.com}#" \
    "$ENVF"
  sed -i "1i # Logbook — production env on the Dell (generated $(date +%F)). Not in git." "$ENVF"
  chmod 600 "$ENVF"
  echo "wrote $ENVF (generated database password + sign-in secret)"
else
  echo "keeping existing $ENVF"
fi

MISSING=""
for k in ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD; do grep -q "^$k=." "$ENVF" || MISSING="$MISSING $k"; done
if [ -n "$MISSING" ]; then
  echo
  echo ">> Fill in$MISSING in $ENVF (nano $ENVF), then run this script again."
  echo "   ADMIN_PASSWORD needs 10+ characters; it is only used to create the first admin."
  exit 2
fi

echo "== systemd: logbook"
sed "s#__USER__#$ME#g; s#__APP__#$APP#g" "$APP/deploy/logbook.service" | sudo tee /etc/systemd/system/logbook.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable logbook
echo "$ME ALL=(root) NOPASSWD: /bin/systemctl restart logbook" | sudo tee /etc/sudoers.d/logbook-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/logbook-deploy

echo "== nightly backup: $DB into /var/backups/pg/<date>/ (picked up by pull-dell-backups.ps1)"
sudo tee /etc/cron.d/logbook-backup >/dev/null <<CRON
30 2 * * * root d=/var/backups/pg/\$(date +\%F); mkdir -p \$d && runuser -u postgres -- pg_dump -Fc $DB > \$d/$DB.dump
CRON

echo "== daily deploy at $AT"
chmod +x "$APP"/deploy/*.sh
LINE="$MM $HH * * * $APP/deploy/deploy.sh $BRANCH >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -v 'time-tracking/deploy/deploy.sh' ; echo "$LINE" ) | crontab -
echo "Installed. Now run: $APP/deploy/deploy.sh $BRANCH --force"
