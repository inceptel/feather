1. Run `curl -i http://localhost:$PORT/api/quick-links`.
2. Confirm the response is `200 OK` with `Content-Type: text/html; charset=utf-8` instead of JSON.
3. Confirm the body is the Feather app shell by checking for `<!DOCTYPE html>` and `<title>Feather</title>`.
4. Open `server.js` and confirm there is no explicit `/api/quick-links` route.
5. In that same file, confirm `app.use(express.static(STATIC_DIR));` is followed by the `app.get('/{*path}', ...)` catch-all that sends `index.html`, which explains why `/api/quick-links` falls through to the SPA shell.
