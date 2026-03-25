1. Open `http://localhost:3305/#4baa1292-7fdf-4e87-af47-6731e459b3cd` in a mobile-sized viewport such as `390x844`.
2. Wait for the chat composer to appear, then type `worker4 iter28 delivery state probe` into the textarea without sending it.
3. Open the session drawer with the hamburger button.
4. Select any different session from the drawer.
5. The bug is present if the app navigates to the new session but the composer still contains the exact unsent draft from the previous session.
6. The automated check also confirms the underlying source path in [frontend/src/App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx): the composer uses one global `text` signal and `select()` does not clear or scope that draft when the active session changes.
