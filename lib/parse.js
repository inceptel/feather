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

const OMP_VISIBLE_ROLES = new Set(['user', 'assistant', 'toolResult'])

/**
 * Normalize an OMP toolCall block to Feather's tool_use shape.
 *   OMP:     { type: 'toolCall', id, name, arguments, intent }
 *   Feather: { type: 'tool_use', id, name, input }
 */
function normalizeOmpBlock(block) {
  if (block.type === 'toolCall') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments }
  }
  return block
}

/**
 * Build a tool_result message from an OMP toolResult entry.
 *   OMP message role: 'toolResult' with { toolCallId, toolName, isError, content }
 *   Feather block:    { type: 'tool_result', tool_use_id, content, is_error }
 */
function buildToolResultBlocks(msg) {
  // Flatten content array into a single text string (matches Claude Code tool_result shape)
  let text = ''
  if (Array.isArray(msg.content)) {
    text = msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
  } else if (typeof msg.content === 'string') {
    text = msg.content
  }
  return [{
    type: 'tool_result',
    tool_use_id: msg.toolCallId,
    content: text,
    is_error: !!msg.isError,
  }]
}

export function parseOmpMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'message') return null

    const msg = d.message
    if (!msg || !OMP_VISIBLE_ROLES.has(msg.role)) return null

    // toolResult role → synthesize a tool_result block array
    if (msg.role === 'toolResult') {
      const blocks = buildToolResultBlocks(msg)
      return {
        uuid: d.id,
        role: 'assistant', // present as assistant so frontend renders it in the assistant column
        timestamp: d.timestamp || new Date(msg.timestamp).toISOString(),
        content: blocks,
      }
    }

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
      blocks = content.map(normalizeOmpBlock)
    }

    const hasVisible = blocks.some(b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && b.thinking?.trim()) ||
      b.type === 'tool_use' ||
      b.type === 'tool_result'
    )
    if (!hasVisible) return null

    return {
      uuid: d.id,
      role: msg.role,
      timestamp: d.timestamp || new Date(msg.timestamp).toISOString(),
      content: blocks,
    }
  } catch { return null }
}

// ── Codex (OpenAI Responses) JSONL parser ───────────────────────────────────

const CODEX_META_PREFIXES = ['<environment_context>', '<permissions instructions>', '<skills_instructions>', '<user_instructions>']

function codexExtractText(contentArr) {
  if (!Array.isArray(contentArr)) return ''
  return contentArr
    .filter(b => b && (b.type === 'input_text' || b.type === 'output_text' || b.type === 'summary_text') && b.text)
    .map(b => b.text)
    .join('\n')
    .trim()
}

function codexParseArguments(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return { raw } }
}

export function parseCodexMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'response_item') return null
    const p = d.payload
    if (!p || !p.type) return null

    const ts = d.timestamp

    if (p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') return null
      const text = codexExtractText(p.content)
      if (!text) return null
      if (CODEX_META_PREFIXES.some(pre => text.startsWith(pre))) return null
      return { uuid: p.id || `${ts}:msg`, role: p.role, timestamp: ts, content: [{ type: 'text', text }] }
    }

    if (p.type === 'reasoning') {
      const text = codexExtractText(p.summary)
      if (!text) return null
      return { uuid: p.id || `${ts}:reason`, role: 'assistant', timestamp: ts, content: [{ type: 'thinking', thinking: text }] }
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      return {
        uuid: p.call_id || `${ts}:call`,
        role: 'assistant',
        timestamp: ts,
        content: [{
          type: 'tool_use',
          id: p.call_id,
          name: p.name,
          input: p.type === 'function_call' ? codexParseArguments(p.arguments) : codexParseArguments(p.input),
        }],
      }
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const raw = p.output ?? ''
      let content = raw
      let isError = false
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.output === 'string') content = parsed.output
          if (parsed.metadata?.exit_code != null && parsed.metadata.exit_code !== 0) isError = true
        }
      } catch {}
      return {
        uuid: p.call_id || `${ts}:out`,
        role: 'user',
        timestamp: ts,
        content: [{ type: 'tool_result', tool_use_id: p.call_id, content, is_error: isError }],
      }
    }

    return null
  } catch { return null }
}

// ── Dispatch parser by agent type ───────────────────────────────────────────

export function parseMessageForAgent(line, agent) {
  if (agent === 'omp') return parseOmpMessage(line)
  if (agent === 'codex') return parseCodexMessage(line)
  return parseMessage(line)
}