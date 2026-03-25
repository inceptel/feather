#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP="/home/user/feather-dev/w5/frontend/src/App.tsx"

if ! [ -f "$APP" ]; then
  echo "Missing $APP"
  exit 2
fi

has_closed_default=0
has_hash_only_restore=0
has_hamburger_when_closed=0
has_zero_width_drawer=0
has_drawer_contents_gated=0

rg -F "const [sidebar, setSidebar] = createSignal(false)" "$APP" >/dev/null && has_closed_default=1
rg -F "const hash = location.hash.slice(1)" "$APP" >/dev/null && rg -F "if (hash) select(hash)" "$APP" >/dev/null && has_hash_only_restore=1
rg -F "<Show when={!sidebar()}>" "$APP" >/dev/null && rg -F "onClick={() => setSidebar(true)}" "$APP" >/dev/null && has_hamburger_when_closed=1
rg -F "width: sidebar() ? '300px' : '0'" "$APP" >/dev/null && rg -F "'min-width': sidebar() ? '300px' : '0'" "$APP" >/dev/null && has_zero_width_drawer=1
rg -F "<Show when={sidebar()}>" "$APP" >/dev/null && rg -F 'aria-label="Close session drawer"' "$APP" >/dev/null && has_drawer_contents_gated=1

if [ "$has_closed_default" -eq 1 ] && [ "$has_hash_only_restore" -eq 1 ] && [ "$has_hamburger_when_closed" -eq 1 ] && [ "$has_zero_width_drawer" -eq 1 ] && [ "$has_drawer_contents_gated" -eq 1 ]; then
  echo "BUG ABSENT: root load keeps the drawer closed until the user opens it"
  exit 1
fi

echo "BUG PRESENT: drawer wiring no longer guarantees a closed first paint"
exit 0
