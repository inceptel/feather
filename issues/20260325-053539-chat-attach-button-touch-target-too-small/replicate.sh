#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/feather-chrome-profile-XXXX")"
TARGETS_JSON="$(mktemp "${TMPDIR:-/tmp}/feather-cdp-targets-XXXX.json")"
NODE_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/feather-cdp-script-XXXX.mjs")"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/feather-chrome-log-XXXX.txt")"
CHROME_PORT="${CHROME_PORT:-9222}"
CHROME_PID=""

cleanup() {
  if [ -n "$CHROME_PID" ]; then
    kill "$CHROME_PID" >/dev/null 2>&1 || true
    wait "$CHROME_PID" 2>/dev/null || true
  fi
  rm -rf "$PROFILE_DIR" "$TARGETS_JSON" "$NODE_SCRIPT" "$LOG_FILE"
}
trap cleanup EXIT

cat > "$NODE_SCRIPT" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.env.ROOT;
const targetsPath = process.env.TARGETS_JSON;
const pageUrl = process.env.PAGE_URL;
const wsModule = pathToFileURL(`${root}/node_modules/ws/wrapper.mjs`).href;
const { default: WebSocket } = await import(wsModule);

const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
const pageTarget = targets.find((target) => target.type === 'page');
if (!pageTarget?.webSocketDebuggerUrl) {
  throw new Error('No page target found');
}

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
let loadResolve;
const pageLoaded = new Promise((resolve) => {
  loadResolve = resolve;
});

ws.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message || 'CDP error'));
    } else {
      entry.resolve(message.result);
    }
    return;
  }

  if (message.method === 'Page.loadEventFired') {
    loadResolve();
  }
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await send('Page.navigate', { url: pageUrl });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error('load timeout')), 15000)),
]);
await new Promise((resolve) => setTimeout(resolve, 3000));

const { result } = await send('Runtime.evaluate', {
  expression: `(() => {
    const button = document.querySelector('button[title="Attach file"]');
    if (!button) return { found: false };
    const rect = button.getBoundingClientRect();
    return {
      found: true,
      width: rect.width,
      height: rect.height,
      text: button.textContent.trim(),
      title: button.getAttribute('title')
    };
  })()`,
  returnByValue: true,
});

console.log(JSON.stringify(result.value));
ws.close();
NODE

google-chrome \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --remote-debugging-port="$CHROME_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  about:blank >"$LOG_FILE" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$CHROME_PORT/json/list" >"$TARGETS_JSON" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [ ! -s "$TARGETS_JSON" ]; then
  echo "BUG ABSENT: Chromium CDP did not start"
  exit 1
fi

PAGE_URL="http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf" \
ROOT="$ROOT" \
TARGETS_JSON="$TARGETS_JSON" \
node "$NODE_SCRIPT" >"$TARGETS_JSON.result"

RESULT_JSON="$(cat "$TARGETS_JSON.result")"
WIDTH="$(printf '%s' "$RESULT_JSON" | node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(0, 'utf8')); console.log(data.width ?? '');")"
HEIGHT="$(printf '%s' "$RESULT_JSON" | node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(0, 'utf8')); console.log(data.height ?? '');")"
FOUND="$(printf '%s' "$RESULT_JSON" | node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(0, 'utf8')); console.log(data.found ? 'true' : 'false');")"

if [ "$FOUND" != "true" ]; then
  echo "BUG ABSENT: attach button not found"
  exit 1
fi

if node -e "process.exit((${WIDTH} < 44 || ${HEIGHT} < 44) ? 0 : 1)"; then
  echo "BUG PRESENT: attach button measured ${WIDTH}x${HEIGHT}px"
  exit 0
fi

echo "BUG ABSENT: attach button measured ${WIDTH}x${HEIGHT}px"
exit 1
