1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a mobile viewport sized `390x844`.
2. Wait for the chat session to render and look at the composer along the bottom edge.
3. Inspect the `+` attach control, which is the `button[title="Attach file"]`.
4. Measure its `getBoundingClientRect()` dimensions.
5. The bug is present when either dimension is below the mobile minimum touch target of `44x44` CSS pixels.
