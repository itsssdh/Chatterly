#!/bin/sh
# Builds Chatterly if needed, serves it on a fixed address and opens it in Dia (or your default browser).
# The address is fixed on purpose: a browser keeps data per address, so Chatterly must always be opened at the same one.
cd "$(dirname "$0")/.." || exit 1
URL="http://127.0.0.1:4173/"
[ -d node_modules ] || npm install || exit 1
[ -f dist/index.html ] || npm run build || exit 1
if curl -s -o /dev/null "$URL"; then
  echo "Chatterly is already being served at $URL"
else
  npx vite preview --host 127.0.0.1 --port 4173 --strictPort &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
  sleep 2
fi
open -a Dia "$URL" 2>/dev/null || open "$URL"
echo "Chatterly: $URL   (leave this window open; Ctrl+C stops the server, not your data)"
[ -n "$SERVER" ] && wait $SERVER
