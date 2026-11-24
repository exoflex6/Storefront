#!/bin/bash
# Push this checkout's code to the bot host and restart the bot.
# Usage: ./deploy.sh            (from your machine; needs `ssh botslxc`)
# Never touches .env or users.json on the host.
set -euo pipefail
HOST="${HOST:-botslxc}"
NAME="${NAME:-storefront}"
DIR="/opt/bots/$NAME"
cd "$(dirname "$0")"

rsync -rlt --delete-after --chmod=Du=rwx,Dg=rx,Do=,Fu=rw,Fg=r,Fo= \
  --exclude '.git' --exclude '.env' --exclude 'users.json' --exclude '.users-*' \
  --exclude '.venv' --exclude '__pycache__' --exclude '*.bak*' --exclude 'assets' \
  ./ "$HOST:$DIR/"

ssh "$HOST" "set -e
  chown -R bots:bots $DIR
  cd $DIR
  runuser -u bots -- ./.venv/bin/pip install -q -r requirements.txt
  systemctl restart $NAME
  sleep 5
  systemctl is-active $NAME
  journalctl -u $NAME -n 15 --no-pager -o cat"
