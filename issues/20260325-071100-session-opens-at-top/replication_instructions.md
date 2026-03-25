1. Fetch `http://localhost:$PORT/api/sessions?limit=500` and confirm session `4baa1292-7fdf-4e87-af47-6731e459b3cd` exists with title `worker 4 probe`.
2. Fetch `http://localhost:$PORT/api/sessions/4baa1292-7fdf-4e87-af47-6731e459b3cd/messages` and confirm it is a long transcript with at least 50 messages.
3. Open `http://localhost:$PORT/#4baa1292-7fdf-4e87-af47-6731e459b3cd` in a `390x844` mobile viewport and wait about 5 seconds for the transcript to settle.
4. Inspect the main scrollable chat transcript container on first paint.
5. The bug is present only if that transcript container opens at the top with `scrollTop <= 100`; on this worker's current build it opens near the bottom instead, so the script exits `1`.
