#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
# Bug: Tab state persists when switching sessions — Terminal tab stays active
PORT="${PORT:-3302}"
S="rep-tab-$$"

cleanup() { agent-browser --session-name $S close 2>/dev/null || true; }
trap cleanup EXIT

# open MUST come before set viewport
agent-browser --session-name $S open "http://localhost:$PORT/"
agent-browser --session-name $S set viewport 390 844
agent-browser --session-name $S wait --load networkidle 2>/dev/null
sleep 8

# Helper for sidebar queries (finds 300px sidebar div)
SB_ITEMS="var all=document.querySelectorAll('div');var sb=null;for(var i=0;i<all.length;i++){if(all[i].style.width==='300px'){sb=all[i];break;}}"

# Wait for SPA mount
for i in $(seq 1 10); do
    OK=$(agent-browser --session-name $S eval "document.querySelectorAll('button').length > 0" 2>/dev/null)
    [ "$OK" = "true" ] && break; sleep 1
done

# Check if a session is already loaded
HAS_TABS=$(agent-browser --session-name $S eval "var b=Array.from(document.querySelectorAll('button'));b.some(function(x){return x.textContent==='Chat'})&&b.some(function(x){return x.textContent==='Terminal'})" 2>/dev/null)

if [ "$HAS_TABS" != "true" ]; then
    # Open sidebar (click first button = hamburger)
    agent-browser --session-name $S eval "var btns=Array.from(document.querySelectorAll('button'));var h=btns.find(function(x){return x.textContent.charCodeAt(0)===9776||x.textContent==='\\u2630'});if(h){h.click();'ok'}else{btns[0].click();'fallback'}" 2>/dev/null
    sleep 2

    # Wait for sidebar sessions
    for i in $(seq 1 10); do
        N=$(agent-browser --session-name $S eval "$SB_ITEMS;sb?sb.querySelectorAll('div[style*=cursor]').length:0" 2>/dev/null)
        [ "$N" -gt 0 ] 2>/dev/null && break; sleep 1
    done
    [ ! "$N" -gt 0 ] 2>/dev/null && echo "SKIP: No sidebar sessions" && exit 1

    # Click first session
    agent-browser --session-name $S eval "$SB_ITEMS;sb.querySelectorAll('div[style*=cursor]')[0].click();'ok'" 2>/dev/null
    sleep 4

    # Wait for tabs
    for i in $(seq 1 8); do
        HAS_TABS=$(agent-browser --session-name $S eval "var b=Array.from(document.querySelectorAll('button'));b.some(function(x){return x.textContent==='Chat'})&&b.some(function(x){return x.textContent==='Terminal'})" 2>/dev/null)
        [ "$HAS_TABS" = "true" ] && break; sleep 1
    done
    [ "$HAS_TABS" != "true" ] && echo "SKIP: No tabs after select" && exit 1
fi

HASH_A=$(agent-browser --session-name $S eval "location.hash.slice(1)" 2>/dev/null)
echo "A: $HASH_A"

# Click Chat first (ensure clean state), then Terminal — with retry
for attempt in 1 2 3; do
    agent-browser --session-name $S eval "var c=Array.from(document.querySelectorAll('button')).find(function(x){return x.textContent==='Chat'});if(c)c.click();'ok'" 2>/dev/null
    sleep 0.5
    agent-browser --session-name $S eval "var t=Array.from(document.querySelectorAll('button')).find(function(x){return x.textContent==='Terminal'});if(t)t.click();'ok'" 2>/dev/null
    sleep 1
    TOK=$(agent-browser --session-name $S eval "var b=Array.from(document.querySelectorAll('button')).find(function(x){return x.textContent==='Terminal'});b?getComputedStyle(b).borderBottomColor==='rgb(74, 186, 106)':false" 2>/dev/null)
    [ "$TOK" = "true" ] && break
    sleep 1
done
[ "$TOK" != "true" ] && echo "SKIP: Terminal not active" && exit 1
echo "Terminal active"

# Open sidebar (click hamburger at fixed position top-left)
agent-browser --session-name $S eval "var btns=Array.from(document.querySelectorAll('button'));var h=btns.find(function(x){return x.textContent.charCodeAt(0)===9776});if(h){h.click();'ok'}else{btns[0].click();'fallback'}" 2>/dev/null
sleep 3

# Wait for sidebar sessions (retry with re-click if needed)
N2=0
for i in $(seq 1 15); do
    N2=$(agent-browser --session-name $S eval "$SB_ITEMS;sb?sb.querySelectorAll('div[style*=cursor]').length:0" 2>/dev/null)
    [ "$N2" -gt 1 ] 2>/dev/null && break
    # Re-click hamburger if sidebar hasn't opened
    if [ "$i" = "5" ] || [ "$i" = "10" ]; then
        agent-browser --session-name $S eval "var btns=Array.from(document.querySelectorAll('button'));var h=btns.find(function(x){return x.textContent.charCodeAt(0)===9776});if(h){h.click();'retry'}" 2>/dev/null
    fi
    sleep 1
done
[ ! "$N2" -gt 1 ] 2>/dev/null && echo "SKIP: Need 2+ sessions ($N2)" && exit 1

# Click a session with transparent background (not currently selected)
agent-browser --session-name $S eval "$SB_ITEMS;var items=sb.querySelectorAll('div[style*=cursor]');var clicked=false;for(var j=0;j<items.length;j++){var s=items[j].getAttribute('style')||'';if(s.indexOf('transparent')!==-1){items[j].click();clicked=true;break;}}if(!clicked&&items.length>=2){items[1].click();}'switched'" 2>/dev/null
sleep 4

# Wait for tabs to re-appear after switch
for i in $(seq 1 5); do
    GOT_TABS=$(agent-browser --session-name $S eval "var b=Array.from(document.querySelectorAll('button'));b.some(function(x){return x.textContent==='Chat'})&&b.some(function(x){return x.textContent==='Terminal'})" 2>/dev/null)
    [ "$GOT_TABS" = "true" ] && break; sleep 1
done

HASH_B=$(agent-browser --session-name $S eval "location.hash.slice(1)" 2>/dev/null)
echo "B: $HASH_B"

if [ -n "$HASH_A" ] && [ "$HASH_A" = "$HASH_B" ]; then echo "SKIP: Same hash"; exit 1; fi
if [ -z "$HASH_B" ] || [ "$HASH_B" = '""' ]; then echo "SKIP: Empty hash"; exit 1; fi

# Check tab state
RESULT=$(agent-browser --session-name $S eval "var b=Array.from(document.querySelectorAll('button'));var t=b.find(function(x){return x.textContent==='Terminal'});var c=b.find(function(x){return x.textContent==='Chat'});if(!t||!c){'no-tabs'}else{JSON.stringify({termActive:getComputedStyle(t).borderBottomColor==='rgb(74, 186, 106)',chatActive:getComputedStyle(c).borderBottomColor==='rgb(74, 186, 106)'})}" 2>/dev/null)
echo "Tabs: $RESULT"

if echo "$RESULT" | grep -q 'termActive[^,]*true'; then
    echo "BUG PRESENT"
    exit 0
else
    echo "BUG ABSENT"
    exit 1
fi
