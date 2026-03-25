1. Open Feather on a mobile viewport (`390x844`).
2. Load the session `370e2f60-1399-4ebf-a182-7a8ba6c59ccf` directly.
3. Locate the visible chat composer at the bottom of the transcript.
4. Inspect the textarea's labeling hooks and the accessibility tree entry for that control.
5. The bug is present when the visible composer uses placeholder text `Send a message...`, has no `aria-label`, no `aria-labelledby`, and no associated `<label>`, while Chromium still exposes the textbox in the accessibility tree as `Send a message...`.

The automated repro opens the reported session on a mobile viewport, finds the visible composer textarea, records its labeling attributes, and captures the page's ARIA snapshot. It reports the bug only when the textarea has no persistent programmatic label and the accessibility tree names the textbox from the placeholder text.
