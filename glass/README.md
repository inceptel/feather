# Feather Glass

Feather on Meta Ray-Ban Display glasses. The glasses run web apps in a 600×600
on-device browser: swipes and pinches from the touchpad or Neural Band arrive
as arrow keys and Enter, and a text field opens the system composer
(handwriting, dictation, keyboard). This is a small gateway that serves one
page built for that and proxies a narrow slice of the Feather API.

It is a separate, optional process. It needs only Node 22, adds nothing to
`server.js`, and restarting it never touches a chat.

## What the page does

- Swipe left and right between recent chats; swipe up and down to page through
  the latest messages.
- Pinch to jump to the bottom, then pick **Suggest replies** (four short
  drafts written by `claude -p`, tools disabled) or **Write a reply** (the
  system composer). A suggestion fills the draft; a second pinch sends it.
- A banner and a chime when a chat finishes while the page is open.
- If the Feather server offers `/api/running` and `/api/sessions/:id/answer`
  (a downstream fork does; this repository does not yet), menu questions show
  as swipeable choices. Without them the page uses `isActive` from
  `/api/sessions` and simply shows no choices.

## Nuggets (optional second page)

`/glass/nuggets` listens to the conversation around the wearer and shows an
occasional one-line aside: a fact check, trivia, a joke, or a tip. Most of the
time it shows nothing, by design.

- Audio comes from the glasses if their browser offers a microphone, otherwise
  from a phone page, `/glass-mic`, opened by the signed-in owner.
- Seven-second clips go to OpenAI transcription (`FEATHER_OPENAI_API_KEY` or
  `OPENAI_API_KEY`), silent clips are dropped in the browser, and each clip is
  discarded after transcription. The transcript lives in memory for five
  minutes and is never written to disk.
- `claude -p` (tools disabled) reads the recent transcript and decides whether
  anything is worth saying.
- Without a key the page loads and reports that it cannot hear. It does not
  use Feather's API at all, so it can be deleted (`nuggets.js` and two lines in
  `server.js`) without affecting the chats page.

This records people nearby. Tell them.

## Access model

The glasses cannot use a password sign-in: the composer does not open on
password fields. So a device is paired instead.

1. The glasses open `/glass/` and show a six-digit code.
2. The owner opens `/glass-approve` on a signed-in device and types it.
3. The glasses receive a random 256-bit token, kept in `localStorage`. The
   gateway stores only its hash (`tokens.json`, mode 600).

A paired device can read recent chats, send replies to them, and post audio
to Nuggets. "Unpair all
devices" on the approve page revokes every token.

This only makes sense behind a reverse proxy that signs people in and passes
their name as `Remote-User` (Authelia, Authentik, oauth2-proxy). The proxy must
strip that header from incoming requests, and enforce this split:

| Path | Proxy rule | Guard inside the gateway |
| --- | --- | --- |
| `/glass`, `/glass/`, `/glass/nuggets` | no sign-in | none (static shells) |
| `/glass/api/*` | no sign-in | device token, except the two pairing calls |
| `/glass-approve`, `/glass-mic`, `/glass-mic/*` | sign-in required | `Remote-User` equals `GLASS_OWNER`, same-origin check, CSRF token |

Caddy:

```
@needsauth not path /glass /glass/ /glass/nuggets /glass/api/*
forward_auth @needsauth localhost:9091 { ... }

@glass path /glass /glass/ /glass/nuggets /glass/api/* /glass-approve /glass-mic /glass-mic/*
handle @glass {
    reverse_proxy 127.0.0.1:4896
}
```

## Running it

```
GLASS_ORIGIN=https://you.example GLASS_OWNER=you node glass/server.js
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `GLASS_ORIGIN` | required | Public https origin the page is served from |
| `GLASS_OWNER` | required | The `Remote-User` allowed to pair devices |
| `GLASS_PORT` | `4896` | Localhost port |
| `GLASS_FEATHER` | `http://127.0.0.1:4870` | The Feather server to proxy |
| `GLASS_STATE` | `~/.feather/glass` | Where `tokens.json` lives |
| `GLASS_CLAUDE` | `claude` | CLI used for suggested replies and Nuggets |
| `FEATHER_OPENAI_API_KEY` or `OPENAI_API_KEY` | none | Transcription for Nuggets |
| `NUGGETS_MODEL` / `NUGGETS_TRANSCRIBE` / `NUGGETS_LANG` | `sonnet` / `gpt-4o-mini-transcribe` / `en` | Nuggets models and language (`auto` to detect) |

On the glasses: Meta AI app, Developer Mode on, then App Settings > Apps > Web
Apps > Connect Web App, and enter `https://<host>/glass/`.

## Test

`node glass/test/e2e.js <screenshot dir>` from the repository root (so
`playwright` resolves). It starts a mock Feather and a fake `claude`, then
drives the page in a 600×600 browser: access checks, pairing, swiping, replies,
suggestions, menu answers, notices, unpairing.

`node glass/test/nuggets-check.js <dir> <48 kHz mono wav>` plays a recording
into a fake microphone and waits for a nugget. It calls the real transcription
and model services, so it needs a key and costs a few cents.

## Status

Used by one person on one pair of glasses, against a downstream fork. Against
this repository's API it has only been checked with a mock: the fallback to
`isActive` works there, but the gateway has not been run against an unmodified
upstream server. Whether the chime is audible on the glasses, and whether their browser gives
web apps a microphone at all, are unconfirmed; Nuggets has so far been driven
from the phone page and from a fake microphone in the test.
