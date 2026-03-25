1. Fetch `http://localhost:$PORT/api/sessions` and pick any session whose `isActive` field is `false`.
2. Open `http://localhost:$PORT/#<that-session-id>` on a `390x844` viewport and wait for the header to show the green `Resume` button.
3. Tap `Resume` and confirm the header immediately switches away from the `Resume` button into the resumed-looking header state.
4. Wait about three seconds, then fetch `http://localhost:$PORT/api/sessions` again and inspect the same session.
5. The bug is present if that session still reports `"isActive": false` even though the UI already hid the `Resume` button.
