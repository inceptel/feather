#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:$PORT"
TARGET_TITLE="worker 4 probe"
S="replicate-chat-overlap-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

TARGET_ID="$(curl -fsS "$BASE/api/sessions?limit=500" | jq -r --arg title "$TARGET_TITLE" 'first((.sessions // [])[] | select(.title == $title) | .id) // empty')"

if [ -z "$TARGET_ID" ]; then
  echo "BUG ABSENT: could not find session titled '$TARGET_TITLE' at $BASE/api/sessions"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844
agent-browser --session-name "$S" open "$BASE/#$TARGET_ID"
agent-browser --session-name "$S" wait 3000

RESULT="$(agent-browser --session-name "$S" eval 'JSON.stringify((() => { const buttons=[...document.querySelectorAll("button")]; const chatButton=buttons.find((el)=> (el.textContent||"").trim()==="Chat"); const tabs=chatButton ? chatButton.parentElement : null; const scrollers=[...document.querySelectorAll("div")].filter((el)=> getComputedStyle(el).overflowY==="auto"); const chatScroller=scrollers.find((el)=> el.querySelector(".markdown")); const rows=chatScroller ? [...chatScroller.children] : []; const tabBottom=tabs ? tabs.getBoundingClientRect().bottom : null; const visibleRows=rows.map((row)=>({rect:row.getBoundingClientRect(), text:(row.textContent||"").trim().slice(0,120)})).filter((item)=> item.rect.height>0 && item.text && (tabBottom===null || item.rect.bottom>tabBottom)).sort((a,b)=> a.rect.top-b.rect.top); const firstVisible=visibleRows.length ? visibleRows[0] : null; return {tabBottom:tabBottom, scrollerTop: chatScroller ? chatScroller.getBoundingClientRect().top : null, firstVisibleTop:firstVisible ? firstVisible.rect.top : null, firstVisibleBottom:firstVisible ? firstVisible.rect.bottom : null, firstVisibleText:firstVisible ? firstVisible.text : null, overlap:(firstVisible && tabBottom!==null) ? firstVisible.rect.top < tabBottom : null}; })())')"

OVERLAP="$(printf '%s' "$RESULT" | jq -r 'fromjson | .overlap')"
TAB_BOTTOM="$(printf '%s' "$RESULT" | jq -r 'fromjson | .tabBottom')"
FIRST_TOP="$(printf '%s' "$RESULT" | jq -r 'fromjson | .firstVisibleTop')"
FIRST_TEXT="$(printf '%s' "$RESULT" | jq -r 'fromjson | .firstVisibleText')"

if [ "$OVERLAP" = "true" ]; then
  echo "BUG PRESENT: first visible transcript row starts at y=$FIRST_TOP under the tab strip bottom y=$TAB_BOTTOM"
  echo "First visible row: $FIRST_TEXT"
  exit 0
fi

echo "BUG ABSENT: first visible transcript row starts at y=$FIRST_TOP at or below the tab strip bottom y=$TAB_BOTTOM"
exit 1
