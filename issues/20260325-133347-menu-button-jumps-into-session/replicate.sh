#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_FILE="/home/user/feather-dev/w5/frontend/src/App.tsx"
HAMBURGER_BLOCK=""
SESSION_BLOCK=""

probe_source() {
  HAMBURGER_BLOCK="$(sed -n '/\/\* Hamburger \*\//,/\/\* Sidebar \*\//p' "$APP_FILE")"
  SESSION_BLOCK="$(awk '/<For each={sessions()}>/{flag=1} flag{print} /<\/For>/{flag=0}' "$APP_FILE")"
}

probe_source

if printf '%s' "$HAMBURGER_BLOCK" | grep -Fq 'onClick={() => setSidebar(true)}' \
  && ! printf '%s' "$HAMBURGER_BLOCK" | grep -Fq 'select(' \
  && printf '%s' "$HAMBURGER_BLOCK" | grep -Fq '<Show when={!sidebar()}>' \
  && printf '%s' "$HAMBURGER_BLOCK" | grep -Fq '&#9776;' \
  && printf '%s' "$SESSION_BLOCK" | grep -Fq 'onClick={() => select(s.id)}'
then
  echo "BUG ABSENT: App.tsx wires the hamburger only to setSidebar(true) and reserves select(s.id) for drawer rows"
  echo "Hamburger block: $HAMBURGER_BLOCK"
  echo "Session rows: $SESSION_BLOCK"
  exit 1
fi

if printf '%s' "$HAMBURGER_BLOCK" | grep -Fq 'select('
then
  echo "BUG PRESENT: the hamburger block itself is wired to session selection"
  echo "Hamburger block: $HAMBURGER_BLOCK"
  exit 0
fi

echo "BUG ABSENT: no hamburger-to-session wiring was found in App.tsx"
echo "Hamburger block: $HAMBURGER_BLOCK"
exit 1
