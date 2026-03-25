1. Open `http://localhost:$PORT/` on a mobile viewport (`390x844`).
2. Open the session drawer with the hamburger button.
3. Select the long-titled worker session `WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 WORKER_DIR=/home/user/`.
4. Wait for the session to load and inspect the sticky header.
5. Observe that the header title is ellipsized into an indistinguishable fragment instead of showing enough of the active session title to identify it.
6. In the current reproduction, the header title span measures about `231px` wide while its text needs about `766px`, so `scrollWidth > clientWidth` confirms the truncation.
