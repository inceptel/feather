# Bug: API send returns ok but drops the message for a new session

## Status
new

## Severity
medium

## Steps to reproduce
1. Create a fresh session ID and POST it to `http://localhost:3304/api/sessions`.
2. POST `{"text":"markdown link probe [OpenAI](https://openai.com)"}` to `http://localhost:3304/api/sessions/7e56faf4-a780-4c12-8767-165085d29197/send`.
3. Observe the API returns `200 {"ok":true,"sentAt":"2026-03-25T14:18:29.457Z"}`.
4. Fetch `http://localhost:3304/api/sessions` and confirm that session ID is missing from the returned list.
5. Fetch `http://localhost:3304/api/sessions/7e56faf4-a780-4c12-8767-165085d29197/messages` and confirm the response is `{"messages":[]}`.
6. Open `http://localhost:3304/#7e56faf4-a780-4c12-8767-165085d29197` on mobile (`390x844`).

## Expected behavior
If the server returns `ok: true` for `send`, the newly created session should exist in the session list, persist the sent message, and load that transcript in the UI.

## Actual behavior
The server acknowledges the send, but the new session never appears in `/api/sessions` and its message list stays empty. Opening the accepted session URL in Feather lands on the blank `Select a session` state because there is no persisted transcript to load.

## Screenshots
- markdown-link-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
- URL: `http://localhost:3304/#7e56faf4-a780-4c12-8767-165085d29197`
