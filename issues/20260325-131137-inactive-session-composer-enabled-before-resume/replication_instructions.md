1. Open Feather on mobile at `390x844`.
2. Find any session that is inactive in `GET /api/sessions` (`isActive: false`).
3. Navigate directly to `/#<inactive-session-id>`.
4. Wait for the session view to load.
5. Confirm the header still shows `Resume`, proving the session is inactive.
6. Check the bottom composer.
7. The bug is present if the textarea plus `+` and `Send` controls are still enabled before the user resumes the session.
