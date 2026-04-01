// Pure JSONL parsing functions — imported by server.js and tests

const STRIP_TAGS = ['local-command-caveat', 'command-name', 'command-message', 'command-args', 'persisted-output']

// ── Claude Code JSONL parser ────────────────────────────────────────────────

export function parseMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'user' && d.type !== 'assistant') return null
    if (d.isSidechain || d.isMeta || !d.message) return null

    const content = d.message.content
    if (!content) return null
    if (Array.isArray(content) && content.length === 0) return null
    if (typeof content === 'string' && content.trim() === '') return null

    let blocks
    if (typeof content === 'string') {
      let text = content
      for (const tag of STRIP_TAGS) {
        text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
      }
      text = text.trim()
      if (!text) return null
      blocks = [{ type: 'text', text }]
    } else {
      blocks = content
    }

    // Skip messages where every block is invisible (e.g. empty thinking placeholders)
    const hasVisible = blocks.some(b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && b.thinking?.trim()) ||
      b.type === 'tool_use' ||
      b.type === 'tool_result'
    )
    if (!hasVisible) return null

    return { uuid: d.uuid, role: d.message.role, timestamp: d.timestamp, content: blocks }
  } catch { return null }
}

// ── oh-my-pi (omp) JSONL parser ─────────────────────────────────────────────

const OMP_VISIBLE_ROLES = new Set(['user', 'assistant'])

export function parseOmpMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'message') return null

    const msg = d.message
    if (!msg || !OMP_VISIBLE_ROLES.has(msg.role)) return null

    const content = msg.content
    if (!content) return null
    if (Array.isArray(content) && content.length === 0) return null
    if (typeof content === 'string' && content.trim() === '') return null

    let blocks
    if (typeof content === 'string') {
      const text = content.trim()
      if (!text) return null
      blocks = [{ type: 'text', text }]
    } else {
      blocks = content
    }

    const hasVisible = blocks.some(b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && b.thinking?.trim()) ||
      b.type === 'tool_use' ||
      b.type === 'tool_result'
    )
    if (!hasVisible) return null

    // Normalize to Feather's internal format
    return {
      uuid: d.id,
      role: msg.role,
      timestamp: d.timestamp || new Date(msg.timestamp).toISOString(),
      content: blocks,
    }
  } catch { return null }
}

// ── Dispatch parser by agent type ───────────────────────────────────────────

export function parseMessageForAgent(line, agent) {
  return agent === 'omp' ? parseOmpMessage(line) : parseMessage(line)
}
