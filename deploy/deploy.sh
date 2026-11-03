#!/usr/bin/env bash
# Pull, update the database, build app + server, restart. Same contract as the
# other apps on the Dell: no-op when origin has nothing new, runs from a private
# copy so a pull can't rewrite the running script, logs to deploy/deploy.log.
#   deploy/deploy.sh [branch] [--force]
set -euo pipefail
if [[ -z "${DEPLOY_FROM_COPY:-}" ]]; then
  _copy=$(mktemp /tmp/logbook-deploy.XXXXXX); cp "${BASH_SOURCE[0]}" "$_copy"
  DEPLOY_FROM_COPY="${BASH_SOURCE[0]}" exec bash "$_copy" "$@"
fi
APP="$(cd "$(dirname "$DEPLOY_FROM_COPY")/.." && pwd)"
BRANCH="${1:-main}"; FORCE="${2:-}"
LOG="$APP/deploy/deploy.log"; exec > >(tee -a "$LOG") 2>&1
echo "===== logbook deploy $(date '+%F %T') branch=$BRANCH"

cd "$APP"; git fetch origin; git checkout -q "$BRANCH"
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse "origin/$BRANCH")
if [[ "$LOCAL" == "$REMOTE" && "$FORCE" != "--force" ]]; then echo "up to date ($LOCAL) — nothing to deploy"; exit 0; fi
git pull --ff-only origin "$BRANCH"; chmod +x "$APP"/deploy/*.sh
git log --oneline "$LOCAL..HEAD" | sed 's/^/   /'

echo "== server deps + database"
cd "$APP/server"; npm ci
# db push adds new tables/columns. Without --accept-data-loss it stops on any
# change that would drop data, so a bad schema change can't wipe punches.
npx prisma db push --skip-generate
npx prisma generate
# Seed is safe to re-run: adds new phases, jobs and expense categories only;
# leaves names, account codes and people that were changed under Manage alone.
npm run seed

echo "== app build (into server/public)"
cd "$APP/client"; npm ci; npm run build

echo "== server build"
cd "$APP/server"; npm run build
test -f dist/main.js || { echo "BUILD INCOMPLETE: dist/main.js missing"; exit 1; }
test -f public/index.html || { echo "BUILD INCOMPLETE: public/index.html missing"; exit 1; }

echo "== restart"
sudo systemctl restart logbook; sleep 3
systemctl --no-pager --lines=3 status logbook || true
curl -fsS http://localhost:5400/api/v1/health && echo
echo "===== done $(date '+%F %T')"
