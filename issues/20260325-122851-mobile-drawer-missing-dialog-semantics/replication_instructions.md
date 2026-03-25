1. Open `http://localhost:3305/` in a mobile-sized Chromium viewport (`390x844`).
2. Confirm the hamburger button is visible, then tap it to open the session drawer.
3. Verify the drawer opened by checking that the `Close session drawer` button is now present.
4. Inspect the current drawer implementation in [frontend/src/App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx#L166).
5. The bug is present when the open drawer is still rendered from plain `div` containers and the drawer container has no `role="dialog"` and no `aria-modal="true"`.

`replicate.sh` automates the mobile open-drawer flow with `agent-browser`, then checks the current source to confirm the rendered drawer markup still lacks dialog semantics.
