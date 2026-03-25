1. Open `http://localhost:$PORT/` in Chromium on a mobile viewport (`390x844`).
2. Open the session drawer with the hamburger button.
3. Tap the existing session named `hello old friend`.
4. Observe that the browser leaves the current worker instance and lands on `http://localhost:3301/` instead of staying on `http://localhost:$PORT/`.
