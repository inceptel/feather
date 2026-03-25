#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
WORKTREE="${WORKTREE:-/home/user/feather-dev/w5}"

RESULT="$(
node - "$PORT" "$WORKTREE" <<'NODE'
const port = Number(process.argv[2]);
const cwd = process.argv[3];

async function waitForWs(url, timeoutMs = 4000) {
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ event: 'timeout' }), timeoutMs);
    ws.addEventListener('open', () => finish({ event: 'open' }));
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (ev) => finish({ event: 'close', code: ev.code, reason: ev.reason }));
  });
}

(async () => {
  const id = `replicate-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;

  const create = await fetch(`${baseHttp}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, cwd }),
  });

  if (!create.ok) {
    console.log(JSON.stringify({ ok: false, reason: `session create failed: ${create.status}` }));
    return;
  }

  const bad = await waitForWs(`${baseWs}/new-dev/api/terminal?session=${id}`);
  const good = await waitForWs(`${baseWs}/api/terminal?session=${id}`);
  const bugPresent = bad.event !== 'open' && good.event === 'open';

  console.log(JSON.stringify({ ok: bugPresent, id, bad, good }));
})().catch((error) => {
  console.log(JSON.stringify({ ok: false, reason: error.message }));
});
NODE
)"

echo "$RESULT"

if echo "$RESULT" | rg -q '"ok":true'; then
  echo "BUG PRESENT"
  exit 0
else
  echo "BUG ABSENT"
  exit 1
fi
