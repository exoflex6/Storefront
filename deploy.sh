#!/bin/bash
# Push the committed code (HEAD) to the bot host and restart the bot.
# Usage: ./deploy.sh            (from your machine; needs `ssh botslxc`)
# Never touches .env, users.json or the venv on the host.
set -euo pipefail
HOST="${HOST:-botslxc}"
NAME="${NAME:-storefront}"
DIR="/opt/bots/$NAME"
cd "$(dirname "$0")"

git diff --quiet HEAD -- || echo "note: uncommitted changes are NOT deployed (deploying $(git rev-parse --short HEAD))"

git archive --format=tar HEAD -- ':!assets' | ssh "$HOST" "set -e
  test -d $DIR/.venv || { echo '$DIR/.venv missing - run newbot.sh first'; exit 1; }
  tar -x --no-same-owner -C $DIR
  chown -R bots:bots $DIR
  chmod 600 $DIR/.env
  cd $DIR
  runuser -u bots -- ./.venv/bin/pip install -q -r requirements.txt
  systemctl restart $NAME
  sleep 6
  systemctl is-active $NAME
  journalctl -u $NAME -n 15 --no-pager -o cat"
