#!/bin/bash
# Exit 0 = bug present, Exit 1 = bug absent
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_JS="$(cd "${ISSUE_DIR}/../.." && pwd)/server.js"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HEADERS="$TMP_DIR/headers.txt"
BODY="$TMP_DIR/body.txt"

curl -sS -D "$HEADERS" "${BASE}/api/quick-links" -o "$BODY"

if ! grep -qi '^HTTP/.* 200 ' "$HEADERS"; then
  echo "BUG ABSENT: /api/quick-links no longer returns HTTP 200"
  exit 1
fi

if ! grep -qi '^Content-Type: text/html' "$HEADERS"; then
  echo "BUG ABSENT: /api/quick-links is no longer served as text/html"
  exit 1
fi

if ! grep -q '<!DOCTYPE html>' "$BODY" || ! grep -q '<title>Feather</title>' "$BODY"; then
  echo "BUG ABSENT: /api/quick-links response is no longer the Feather SPA shell"
  exit 1
fi

if grep -Fq "app.get('/api/quick-links'" "$SERVER_JS" || grep -Fq 'app.get("/api/quick-links"' "$SERVER_JS"; then
  echo "BUG ABSENT: server.js defines an explicit /api/quick-links route"
  exit 1
fi

if ! grep -Fq "app.use(express.static(STATIC_DIR));" "$SERVER_JS"; then
  echo "BUG ABSENT: server.js no longer serves the frontend bundle before the catch-all"
  exit 1
fi

if ! grep -Fq "app.get('/{*path}', (_req, res) => {" "$SERVER_JS"; then
  echo "BUG ABSENT: server.js no longer has the SPA catch-all route"
  exit 1
fi

if ! grep -Fq "res.sendFile(index);" "$SERVER_JS"; then
  echo "BUG ABSENT: SPA catch-all no longer sends index.html"
  exit 1
fi

echo "BUG PRESENT: /api/quick-links returns the SPA shell via the static/catch-all fallback"
exit 0
