1. Create or open any chat session so the mobile composer is available. The automated repro seeds its own session file and loads it directly with `/#<session-id>`.
2. On a mobile viewport (`390x844`), open the Feather session drawer with the hamburger button.
3. Without dismissing the drawer, target the still-visible background composer controls.
4. Enter `drawer modal probe` and activate `Send`.
5. The bug is present if the textarea and `Send` button remain visible while the drawer is open and the transcript immediately accepts the probe text anyway.
