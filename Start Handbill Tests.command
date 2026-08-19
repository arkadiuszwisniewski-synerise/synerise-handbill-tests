#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)…"
  npm install
fi

echo "Starting Handbill Tests on http://localhost:3000"
echo "Close this window to stop the server."
echo

(sleep 1 && open "http://localhost:3000") &
# dev = node --watch: the server restarts itself when server.js changes,
# so new API routes are picked up without closing this window.
exec npm run dev
