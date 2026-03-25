1. Open `http://localhost:$PORT/` on a mobile-sized viewport such as `390x844`.
2. Confirm the landing screen renders `Open a session or create a new one`.
3. Read `document.title`; it remains the generic `Feather`.
4. Open the session drawer.
5. Select the `hello old friend` transcript.
6. Confirm that transcript is visibly open and the hash changes to `#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`.
7. Read `document.title` again; it still stays `Feather` instead of reflecting the selected session.
