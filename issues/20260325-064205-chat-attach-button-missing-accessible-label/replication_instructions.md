1. Open Feather on a mobile viewport (`390x844`).
2. Load the session titled `worker 4 probe`.
3. Inspect the chat composer and locate the attach control, which is the visible `+` button with `title="Attach file"`.
4. Check the control's accessible naming attributes.
5. The bug is present when the button is rendered as `+` but has no `aria-label` and no `aria-labelledby`, so assistive technology only gets the glyph instead of a descriptive name such as `Attach file`.

The automated repro fetches the `worker 4 probe` session id from `/api/sessions`, opens that session directly, and inspects the visible attach button in the DOM. It reports the bug when the button is present with text `+` and both `aria-label` and `aria-labelledby` are empty.
