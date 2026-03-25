1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in Chromium with a mobile viewport of `390x844`.
2. Scroll to the assistant markdown message that starts with `There it is! w5 found it:`.
3. Inspect the fenced JSON block inside that bubble.
4. The bug is present when the `<pre>` stays narrow enough for the bubble but the code line remains unwrapped, producing horizontal overflow inside the bubble instead of fitting within the mobile layout.
