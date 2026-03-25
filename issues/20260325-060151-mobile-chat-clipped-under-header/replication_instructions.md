1. Open `http://localhost:$PORT/` on a mobile viewport such as `390x844`.
2. Load the session titled `worker 4 probe`.
3. Stay on the `Chat` tab and look at the topmost visible transcript row.
4. The bug is present if that first visible row starts above the bottom edge of the Chat/Terminal tab strip, so part of the message is hidden underneath the sticky header area.

The automated repro opens `worker 4 probe` by hash, then compares the first visible transcript row's `getBoundingClientRect().top` against the tab strip's `bottom`. It reports the bug when the row top is smaller than the tab strip bottom.
