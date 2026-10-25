// User-role messages that Feather or a tool wrote, not the person: show them as
// one collapsed line with an emoji instead of a full bubble.

export interface AgentNotice {
  icon: string
  label: string
  // The text to show when expanded, without a <pasted_content> wrapper.
  body: string
}

const PASTED = /^<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">\s*$/

export function agentNotice(text: string): AgentNotice | null {
  const trimmed = text.trim()
  const body = (PASTED.exec(trimmed)?.[1] ?? trimmed).trim()
  if (/^\[feather-sidecar [^\]]+\]/.test(body)) return { icon: '🛰️', label: 'Sidecar message', body }
  if (/^(You are part of a Creator–Reviewer \(CR\) pair in Feather\.|# Feather Ralph:|You are a Feather \*\*sidecar\*\* agent\.)/.test(body)) {
    return { icon: '⚙️', label: 'Agent setup', body }
  }
  const ralph = /^<feather-ralph-callback\b([^>]*)>/.exec(body)
  if (ralph) {
    const iteration = /\biteration="(\d+)"/.exec(ralph[1])?.[1]
    return { icon: '🖍️', label: iteration ? `Ralph · iteration ${iteration}` : 'Ralph', body }
  }
  if (/^(Feather ongoing work is enabled|The user clicked Keep working\.)/.test(body)) return { icon: '🖍️', label: 'Ralph', body }
  if (/^This session is being continued from a previous conversation/.test(body)) return { icon: '🗜️', label: 'Compacted', body }
  const inbox = /^Plannotator Inbox reply on "([^"\n]*)"/.exec(body)
  if (inbox) return { icon: '📬', label: `Inbox reply · ${inbox[1]}`, body }
  return null
}
