#!/bin/bash
# Exit 0 = bug present, Exit 1 = bug absent
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-menu-expanded-$$"
CLOSED_STATE=""
OPEN_STATE=""

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

probe_once() {
  agent-browser --session-name "$S" set viewport 390 844 >/dev/null
  agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
  agent-browser --session-name "$S" wait --load networkidle >/dev/null
  agent-browser --session-name "$S" wait 1500 >/dev/null

  INITIAL_STATE="$(agent-browser --session-name "$S" eval '(() => {
    const menu = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
    const close = document.querySelector("button[aria-label=\"Close session drawer\"]") ||
      [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "×");
    if (menu) return "closed";
    if (close) return "open";
    return "unknown";
  })()')"

  if [ "$INITIAL_STATE" = '"closed"' ]; then
    CLOSED_STATE="$(agent-browser --session-name "$S" eval '(() => {
      const button = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
      if (!button) return { found: false, state: "closed" };
      return {
        found: true,
        state: "closed",
        text: (button.textContent || "").trim(),
        ariaExpanded: button.getAttribute("aria-expanded"),
        ariaControls: button.getAttribute("aria-controls")
      };
    })()')"

    agent-browser --session-name "$S" eval '(() => {
      const button = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
      if (!button) return false;
      button.click();
      return true;
    })()' >/dev/null
    agent-browser --session-name "$S" wait 500 >/dev/null

    OPEN_STATE="$(agent-browser --session-name "$S" eval '(() => {
      const button = document.querySelector("button[aria-label=\"Close session drawer\"]") ||
        [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "×");
      if (!button) return { found: false, state: "open" };
      return {
        found: true,
        state: "open",
        text: (button.textContent || "").trim(),
        ariaLabel: button.getAttribute("aria-label"),
        ariaExpanded: button.getAttribute("aria-expanded"),
        ariaControls: button.getAttribute("aria-controls")
      };
    })()')"
  elif [ "$INITIAL_STATE" = '"open"' ]; then
    OPEN_STATE="$(agent-browser --session-name "$S" eval '(() => {
      const button = document.querySelector("button[aria-label=\"Close session drawer\"]") ||
        [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "×");
      if (!button) return { found: false, state: "open" };
      return {
        found: true,
        state: "open",
        text: (button.textContent || "").trim(),
        ariaLabel: button.getAttribute("aria-label"),
        ariaExpanded: button.getAttribute("aria-expanded"),
        ariaControls: button.getAttribute("aria-controls")
      };
    })()')"

    agent-browser --session-name "$S" eval '(() => {
      const button = document.querySelector("button[aria-label=\"Close session drawer\"]") ||
        [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "×");
      if (!button) return false;
      button.click();
      return true;
    })()' >/dev/null
    agent-browser --session-name "$S" wait 500 >/dev/null

    CLOSED_STATE="$(agent-browser --session-name "$S" eval '(() => {
      const button = [...document.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === "☰");
      if (!button) return { found: false, state: "closed" };
      return {
        found: true,
        state: "closed",
        text: (button.textContent || "").trim(),
        ariaExpanded: button.getAttribute("aria-expanded"),
        ariaControls: button.getAttribute("aria-controls")
      };
    })()')"
  else
    return 1
  fi

  printf '%s' "$CLOSED_STATE" | grep -Fq '"found": true'
  printf '%s' "$OPEN_STATE" | grep -Fq '"found": true'
}

PROBE_OK=0
for attempt in 1 2 3; do
  if probe_once; then
    PROBE_OK=1
    break
  fi
  cleanup
  sleep 1
done

if [ "$PROBE_OK" -ne 1 ]; then
  echo "BUG ABSENT: failed to complete browser probe after retries"
  exit 1
fi

if printf '%s' "$CLOSED_STATE" | grep -Fq '"found": true' \
  && printf '%s' "$CLOSED_STATE" | grep -Fq '"ariaExpanded": null' \
  && printf '%s' "$CLOSED_STATE" | grep -Fq '"ariaControls": null' \
  && printf '%s' "$OPEN_STATE" | grep -Fq '"found": true' \
  && printf '%s' "$OPEN_STATE" | grep -Fq '"ariaExpanded": null' \
  && printf '%s' "$OPEN_STATE" | grep -Fq '"ariaControls": null'
then
  echo "BUG PRESENT: drawer toggle exposes no aria-expanded or aria-controls in either state"
  echo "Closed: $CLOSED_STATE"
  echo "Open: $OPEN_STATE"
  exit 0
fi

echo "BUG ABSENT: disclosure semantics are present or the toggle could not be inspected"
echo "Closed: $CLOSED_STATE"
echo "Open: $OPEN_STATE"
exit 1
