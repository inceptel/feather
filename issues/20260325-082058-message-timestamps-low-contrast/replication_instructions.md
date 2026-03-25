1. Open `http://localhost:$PORT/#4baa1292-7fdf-4e87-af47-6731e459b3cd` in a mobile viewport (`390x844`).
2. Wait for the session transcript to render and look at the per-message timestamp text beneath the chat bubbles.
3. Inspect a visible timestamp such as `07:27 AM` or `08:18 AM`.
4. The bug is present if that timestamp renders at `10px` in `rgb(68, 68, 68)` against the dark chat background `rgb(10, 14, 20)`.
5. That combination is only about `1.99:1` contrast, so the timestamp metadata is effectively unreadable on the mobile dark theme.
