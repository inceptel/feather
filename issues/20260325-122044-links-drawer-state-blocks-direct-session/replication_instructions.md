1. Open `http://localhost:$PORT/` on a mobile viewport such as `390x844`.
2. Open the session drawer from the hamburger menu.
3. Switch the drawer to `Links`.
4. In the same tab, change the URL hash to `#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`.
5. The bug is present only if Feather keeps the `Links` drawer open, still shows the empty `Select a session` / `Open a session or create a new one` state, and does not reveal the requested chat.

Current verification note: in this build, [`frontend/src/App.tsx`](/home/user/feather-dev/w5/frontend/src/App.tsx) no longer renders a `Links` drawer switcher, so the reported precondition is missing and the script exits `1`.
