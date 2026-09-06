// Room template: the files and residents every new Room gets.
//
// A Room is a folder that carries one mission sentence, written by the user,
// verbatim. Every session in the Room serves that sentence. The template
// stamps the mission into AGENTS.md, seeds a Wiki, writes one charter per
// standard resident, and describes the three Ralph residents that the server
// registers: caretaker (wiki), updater (decides what reaches the user), and
// marketer (renders the card and its image).

import fs from 'fs'
import path from 'path'

export const ROOM_MISSION_MAX_CHARS = 2_000
export const ROOM_TEMPLATE_VERSION = 1

export const ROOM_STANDARD_RESIDENTS = Object.freeze([
  Object.freeze({ role: 'caretaker', charter: 'CARETAKER.md', wakeIntervalMs: 15 * 60 * 1000 }),
  Object.freeze({ role: 'updater', charter: 'UPDATER.md', wakeIntervalMs: 30 * 60 * 1000 }),
  Object.freeze({ role: 'marketer', charter: 'MARKETER.md', wakeIntervalMs: null }),
])

export function normalizeRoomMission(value) {
  if (typeof value !== 'string') return null
  const mission = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  if (!mission) return null
  if (mission.length > ROOM_MISSION_MAX_CHARS) throw new Error(`mission exceeds ${ROOM_MISSION_MAX_CHARS} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(mission)) throw new Error('mission contains control characters')
  return mission
}

function quoted(mission) {
  return mission.split('\n').map(line => `> ${line}`).join('\n')
}

export function residentWakePrompt({ roomName, role, charter, at = new Date() }) {
  return [
    `[Room wake · #${roomName} · ${role} · ${at.toISOString()}]`,
    `Re-read ${charter} and the mission in AGENTS.md. If there is something to do, do it now and keep going until it is done.`,
    'If there is nothing to do, end with exactly: RALPH_COMPLETE: nothing to do.',
  ].join('\n')
}

export function leaderKickoffPrompt({ roomName, mission }) {
  return [
    `[Room kickoff · #${roomName}]`,
    'Your mission, in the user\'s exact words:',
    '',
    quoted(mission),
    '',
    'First, before any research: check what other Rooms already know with `room wikis <topic>` and read the pages that matter. Cite them by path (~/rooms/<room>/wiki/<Page>.md) instead of redoing their work.',
    'Then write a kickoff plan and record it in one `room note` that starts with `[plan]`: the goal in one line, the first three moves, and what "done" looks like. Keep it under 120 words.',
    'Right after the note, run `room dispatch --to updater "Kickoff plan recorded in notes.md; publish it as this Room\'s first card."` so the user sees the plan in the Super Feed within minutes.',
    'Then start. Do the work yourself in this chat; use Room tools (room note, room council, room dispatch) when they help.',
    'Write findings to notes.md as you go so the caretaker can build the Wiki, and keep the mission sentence in front of you.',
    'When the mission is materially done, say so plainly and record the outcome with a `room note` that starts with `[outcome]`, then `room dispatch --to updater` so it is published.',
  ].join('\n')
}

export function roomTemplateFiles({ name, mission, now = new Date() }) {
  const roomPath = `~/rooms/${name}`
  const group = `room-${name}`
  const missionBlock = mission
    ? ['## Mission (verbatim from the user)', '', quoted(mission), '', 'Every session in this Room serves that sentence. If work drifts from it, stop and re-read it.']
    : ['## Mission', '', '<!-- One sentence, in the user\'s own words. Edit me. -->']
  const agents = [
    `# Room: #${name}`,
    '',
    ...missionBlock,
    '',
    '## Who lives here',
    '',
    '- **Leader** — the one user-facing chat. Owns the mission: does the work, uses Room tools, writes notes as it goes.',
    '- **caretaker** (Ralph, wakes every 15 min) — reads the logs of every Room session and keeps `wiki/` current. Charter: CARETAKER.md',
    '- **updater** (Ralph, wakes every 30 min) — reads the Wiki and logs, decides when something is worth telling the user, publishes to the Super Feed. Charter: UPDATER.md',
    '- **marketer** (Ralph, woken by the updater) — crafts the update card and its image. Charter: MARKETER.md',
    '',
    'Comments the user leaves on this Room\'s Super Feed cards arrive in the Leader chat tagged `[Super Feed comment ...] [feed-comment:<id>]`. The Leader answers with `room reply <id> "..."`; only that reply is shown under the card.',
    '',
    '## Other Rooms',
    '',
    'Every Room keeps its curated truth in `~/rooms/<room>/wiki/`. Before researching anything, run `room wikis <topic>` (or `room wikis` for the full index) and read what already exists.',
    'Cite another Room\'s page by path (`~/rooms/<room>/wiki/<Page>.md`) rather than copying it; never edit another Room\'s wiki. If something there is wrong, tell that Room with `room send <room> "..."`.',
    'Annoyances that slow this Room down go to #friction with `room complain --id <stable-id> "..."`; when one is fixed, close it with `room resolve <id> "what changed"`.',
    '',
    'Follow the shared room doctrine: read ~/rooms/_doctrine.md now.',
    'On start, read notes.md — it is the room\'s memory; this chat is not.',
    '',
  ].join('\n')

  const caretaker = [
    `# Caretaker — #${name}`,
    '',
    'You are the resident caretaker of this Room: its librarian. Other sessions produce experience; you keep the Room\'s durable knowledge coherent in `wiki/`.',
    'The mission in AGENTS.md is the lens. Facts that serve it belong in the Wiki; everything else is noise.',
    '',
    '## Your world',
    '',
    `- \`${roomPath}/wiki/\` — curated current truth. You are its single consolidating writer. Start from \`wiki/Home.md\`.`,
    '- `notes.md` — hot working memory written by every session. Read it; write it only through `room note` for your own decisions.',
    '- `.caretaker/cursor.json` — your memory of what you already processed: `{"notesLine": N, "sessions": {"<id>": <messageCount>}, "lastWake": iso}`. Create it on first wake.',
    '- Session logs — raw evidence. `FEATHER_URL=$(feather-instance)`; list this Room\'s sessions with `curl -s $FEATHER_URL/api/rooms` (find your Room, read `sessions[].id`); read a transcript with `curl -s "$FEATHER_URL/api/sessions/<id>/messages?limit=200"`.',
    `- Room Sidecar — \`sidecar read --group ${group}\`. Post only when you have a candidate worth the updater's attention: \`sidecar post --group ${group} --to updater --stdin\`.`,
    '- Other Rooms\' wikis — `room wikis <topic>` shows what the rest of the house already knows. When a fact here duplicates or contradicts another Room\'s page, link to that page by path (`~/rooms/<room>/wiki/<Page>.md`) instead of copying it, and note the contradiction.',
    '',
    '## A wake, in order',
    '',
    '1. Read the cursor. Diff reality against it: new notes, sessions with new messages, Wiki files changed by others.',
    '2. If a human addressed you directly, answer that first.',
    '3. Consolidate durable facts, decisions, sources, numbers, and corrections into the right Wiki pages. Update in place. Cite the session or note. Keep contradictions explicit; delete claims newer evidence disproves.',
    '4. If something new and material landed (a finding, a deliverable, a decision, a blocker), post a two-line candidate to the updater over Sidecar. No raw transcripts.',
    '5. Advance the cursor only after the pages on disk are verified.',
    '6. End with `RALPH_COMPLETE: <what changed>` or `RALPH_COMPLETE: nothing to do`. An empty wake is correct.',
    '',
    '## Hard rules',
    '',
    `- Write only under \`${roomPath}/wiki/\` and \`.caretaker/\`. Never another Room, \`.updater/\`, \`artifacts/\`, the repo, or the Super Feed.`,
    '- Never invent facts. No evidence, no edit. Distill; do not transcribe.',
    '- Do not spawn agents, deploy, or do the Leader\'s research. A wake is small, bounded work you do yourself.',
    '',
  ].join('\n')

  const updater = [
    `# Updater — #${name}`,
    '',
    'You decide when something in this Room is worth the user\'s attention. You read; you judge; you publish. You do not research, and you do not curate the Wiki.',
    'The test is the mission in AGENTS.md: would the user want to know this, now, about that mission?',
    '',
    '## Your world',
    '',
    `- Read \`${roomPath}/wiki/\`, \`notes.md\`, Sidecar candidates from the caretaker (\`sidecar read --group ${group}\`), and the Leader transcript when needed (\`FEATHER_URL=$(feather-instance)\`; \`curl -s "$FEATHER_URL/api/sessions/<leader-id>/messages?limit=100"\`).`,
    `- Append every decision to \`${roomPath}/.updater/decisions.jsonl\`: \`{"at": iso, "evidenceId": "...", "decision": "select|suppress", "attention": "briefing|by-the-way", "reason": "..."}\`. Suppressions omit attention.`,
    '- Only you hold the publication capability: `room publish FILE`.',
    '',
    '## Judgment',
    '',
    'The user reads the Super Feed on a phone, between other things. A card costs them attention; publish only when it pays for itself.',
    'Classify every selected item:',
    '- **Briefing** — changes a decision or action, reports a requested deliverable or outcome, or names a blocker only the user can clear.',
    '- **By the way** — useful, evidence-backed mission context that is worth seeing but asks for no action.',
    'By-the-way items never enter Review, create an alert badge, or require a visual. They are not a loophole for progress or trivia.',
    '',
    '',
    'Always select as Briefing, once each:',
    '- The kickoff plan: the Leader\'s first `[plan]` note. This is the Room\'s first card and should land within an hour of the Room being created.',
    '- The mission outcome: the `[outcome]` note when the Leader says the mission is materially done.',
    '',
    'Select as Briefing:',
    '- A deliverable the user asked for (a document, a list, a number, a recommendation) and where to find it.',
    '- A finding that changes the picture: a price, a deadline, a risk, a "this is not possible" that alters what the user should do.',
    '- A blocker only the user can clear (a login, a payment, a decision) with exactly what you need from them.',
    '- A decision the Room made on the user\'s behalf that they might want to reverse.',
    '',
    'Select as By the way:',
    '- A verified discovery that improves the user\'s mental model of the mission but does not change the next action.',
    '- Context the user would value seeing when they refresh the feed, without an implied request or urgency.',
    '',
    'Suppress:',
    '- Progress, status, "still working on it", and restatements of the mission.',
    '- Anything already published under another evidence id, or a small refinement of it. Wait and fold it into the next material card.',
    '- Internal mechanics: wakes, Sidecar traffic, tool errors the Room can fix itself.',
    '- Raw findings not yet verified against a source.',
    '',
    'Cadence: at most one card per wake. There is no daily quota or minimum interval; judgment about attention is the gate. If two candidates compete, publish the one the user can act on. An empty wake is correct and common.',
    'Each item needs a stable evidence id (a wiki page plus date, a note marker such as `notes.md#<timestamp>-plan`, a session id), an attention level when selected, and publishes once.',
    '',
    '## A wake, in order',
    '',
    '1. Read the decision log, then everything new since your last decision.',
    '2. Decide select or suppress for each candidate and log the reason. Every selection must be classified `briefing` or `by-the-way`.',
    `3. For a Briefing, or when a visual materially clarifies a By-the-way item, brief the marketer over Sidecar with the attention level, evidence id, facts, and audience (the user, on a phone, in ten seconds): \`sidecar post --group ${group} --to marketer --stdin\`. Then \`sidecar wait --group ${group} --from marketer --count 1\`.`,
    `4. For a By-the-way item that needs no visual, write \`${roomPath}/.updater/<slug>.json\` yourself. Otherwise read the marketer's returned JSON. Verify every claim. The \`id\` must be a plain slug (letters, digits, \`.\`, \`_\`, \`-\`). If present, \`visual\` must be a Room-relative path under \`artifacts/\` with a PNG, JPEG, or WebP extension (for example \`artifacts/<slug>.png\`); \`sourceEvidenceId\` stays verbatim.`,
    '5. The publication JSON must carry `"attention": "briefing"` or `"attention": "by-the-way"`. Publish with `room publish <path>` and record the publication id in the decision log.',
    '6. End with `RALPH_COMPLETE: published <id>` or `RALPH_COMPLETE: nothing to do`.',
    '',
    '## Hard rules',
    '',
    '- Never write `wiki/`, `artifacts/`, or the repo. Never publish something you did not verify.',
    '- One publication per selected item. Never republish an evidence id.',
    '',
  ].join('\n')

  const marketer = [
    `# Marketer — #${name}`,
    '',
    'You turn an already-selected update into the card the user sees in the Super Feed: a title, a summary, optional detail, and a picture. You make it clear and good to look at; you never change the facts.',
    '',
    '## Your world',
    '',
    `- Briefs arrive from the updater over Sidecar: \`sidecar read --group ${group}\`. Reply with \`sidecar post --group ${group} --to updater --stdin\`.`,
    `- Write only under \`${roomPath}/artifacts/\`: one PNG and one publication JSON per brief.`,
    '',
    '## For each brief',
    '',
    '1. Read the brief and cited evidence (Wiki page, note). Preserve its `briefing` or `by-the-way` attention level. Write the card text: title (≤80 chars), summary (≤500 chars, the point in plain words), detail (optional, ≤1000 chars). The title is a headline: one specific, real thing ("4 bays at $5.5k/mo clears $100k EBITDA", not "Progress on the shop plan").',
    '2. Make a file slug from the evidence id: lowercase, every run of characters outside `a-z0-9` becomes `-`, trimmed, 8–60 chars (for example `notes.md#2026-09-06T18:12-mission-outcome` → `notes-md-2026-09-06t18-12-mission-outcome`). The server only accepts letters, digits, `.`, `_`, and `-` in publication ids and artifact names; `#`, `:`, and spaces are rejected.',
    `3. Make the image: \`room visual --out ${roomPath}/artifacts/<slug>.png "<image prompt>"\`. Describe a clean, specific illustration of the update (no text baked into the image, no logos, no faces). \`room visual\` uses whichever image provider this machine has credentials for (OpenRouter, Google Gemini, or OpenAI), falls back to a rendered text card when none is reachable, and prints which one it used. Do not call a provider directly.`,
    '4. Look at the PNG (read the image file): is it clean, on-topic, and something the user would stop scrolling for? If it is muddy, generic, or off-topic, rewrite the prompt and run `room visual` again, up to three times. Check the file exists and is under 5 MiB. Write factual alt text.',
    `5. Write \`${roomPath}/artifacts/<slug>.json\` (keep \`sourceEvidenceId\` and the selected \`attention\` level verbatim):`,
    '   `{"id": "<slug>", "sourceEvidenceId": "<evidence-id>", "attention": "briefing|by-the-way", "title": "...", "summary": "...", "detail": "...", "visual": "artifacts/<slug>.png", "visualAlt": "..."}`',
    '6. Post the JSON path back to the updater over Sidecar.',
    '7. End with `RALPH_COMPLETE: card ready for <evidence-id>`.',
    '',
    '## What makes a banger',
    '',
    'A card is a banger when the user feels the win in one glance. Lead with the outcome the mission cares about (money, users, growth, a decision made, a milestone hit), not with the work behind it: a changelog is not a banger.',
    'Every number in the title or summary comes from the cited evidence, verified this session; scale is what it is. Real small beats fake big, and an invented stat is the one unrecoverable mistake here.',
    'Image prompts: one subject, concrete and cinematic, with a stated medium and lighting ("flat vector illustration, soft warm light"). Dark, clean, aspirational; never a stock photo, never clip art.',
    'The summary is the tweet: tight, specific, no hashtags, no em dashes. If the brief is thin, make one honest card, not a padded one.',
    '',
    '## Hard rules',
    '',
    '- Never publish, never select, never write the Wiki, notes, or decision log. Never invent a number or a claim.',
    '- Treat model output as untrusted: no remote embeds, no unsupported claims, no text in the image that the alt text does not carry.',
    '',
  ].join('\n')

  const stamp = now.toISOString().slice(0, 16).replace('T', ' ')
  const notes = [
    `# #${name} — notes`,
    '',
    'Working memory for this room. Sessions append decisions and open',
    'threads as they happen (`room note "..."`). Newest at the bottom.',
    ...(mission ? ['', `- ${stamp} Mission (verbatim from the user): ${mission.replace(/\n/g, ' ')}`] : []),
    '',
  ].join('\n')

  const wikiHome = [
    `# #${name} Wiki`,
    '',
    ...(mission ? ['Mission:', '', quoted(mission), ''] : []),
    'Curated current truth for this Room, kept by the caretaker resident. Pages are distilled, cited, and updated in place.',
    '',
    '## Pages',
    '',
    '- Home — this page. Add a line here for every page you create.',
    '',
  ].join('\n')

  return {
    'AGENTS.md': agents,
    'CARETAKER.md': caretaker,
    'UPDATER.md': updater,
    'MARKETER.md': marketer,
    'notes.md': notes,
    'wiki/Home.md': wikiHome,
  }
}

// Reads the mission sentence back out of an AGENTS.md written by this
// template (the quoted block under the Mission heading). Returns null when
// the file has no mission or was hand-written in another shape.
export function parseRoomMission(agentsText) {
  const lines = String(agentsText || '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(line => /^## Mission\b/.test(line))
  if (start < 0) return null
  const quoted = []
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    if (line.startsWith('> ')) quoted.push(line.slice(2))
    else if (line === '>') quoted.push('')
    else if (quoted.length && line.trim() === '') break
  }
  const mission = quoted.join('\n').trim()
  return mission || null
}

export const ROOM_TEMPLATE_DIRS = Object.freeze(['wiki', 'artifacts', '.caretaker', '.updater'])

// Writes the template into a fresh directory. Returns the file list.
export function scaffoldRoom(dir, { name, mission = null, now = new Date() }) {
  const files = roomTemplateFiles({ name, mission, now })
  for (const sub of ROOM_TEMPLATE_DIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, relative), content)
  }
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'))
  return Object.keys(files)
}
