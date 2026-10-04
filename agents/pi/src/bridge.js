// Live events for Feather's Chat view.
//
// pi-durable's agent events are mapped to the event types Feather's bridge
// endpoint already accepts from OMP (server.js OMP_BRIDGE_EVENT_TYPES):
// assistant_snapshot / work_snapshot / assistant_end / assistant_cancel,
// tool_execution_*, agent_start / agent_end and session_state. Delivery is
// best effort: a failed post never affects the durable run.
import { randomUUID } from 'node:crypto';

const SNAPSHOT_INTERVAL_MS = 50;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_POST_BYTES = 110_000;
export const BRIDGE_VERSION = 4;

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
}

function workOf(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  let thinkingChars = 0;
  for (const block of content) {
    if (block?.type === 'toolCall' && typeof block.name === 'string' && block.name) {
      blocks.push({ type: 'tool_use', ...(typeof block.id === 'string' ? { id: block.id.slice(0, 128) } : {}), name: block.name.slice(0, 80) });
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      const thinking = block.thinking.slice(-Math.max(0, 3_000 - thinkingChars));
      if (!thinking) continue;
      thinkingChars += thinking.length;
      blocks.push({ type: 'thinking', thinking });
    }
  }
  return blocks.slice(-40);
}

function hasToolCall(content) {
  return Array.isArray(content) && content.some(block => block?.type === 'toolCall');
}

function applyChange(content, change) {
  const next = Array.isArray(content) ? content.slice() : [];
  const at = change.contentIndex;
  if (change.type === 'text_start' || change.type === 'thinking_start' || change.type === 'toolcall_start' || change.type === 'block') {
    next[at] = structuredClone(change.block);
  } else if (change.type === 'text_delta') {
    next[at] = { ...(next[at] || { type: 'text', text: '' }), text: `${next[at]?.text || ''}${change.delta}` };
  } else if (change.type === 'thinking_delta') {
    next[at] = { ...(next[at] || { type: 'thinking', thinking: '' }), thinking: `${next[at]?.thinking || ''}${change.delta}` };
  }
  return next;
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `…${text.slice(text.length - limit)}` : text;
}

function sanitizeArgs(args) {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 20_000 ? { truncated: json.slice(0, 20_000) } : JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * Turns pi-durable agent event batches into Feather bridge events. `emit`
 * receives arrays of events. Pure apart from timers, so tests can drive it.
 */
export function createEventMapper({ emit, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let message = null; // { messageId, content, timer, lastText, lastWork }
  const toolOutput = new Map();

  function flush(state, terminal) {
    const events = [];
    const text = textOf(state.content);
    if (text !== state.lastText) {
      events.push({ type: 'assistant_snapshot', messageId: state.messageId, text });
      state.lastText = text;
    }
    const work = workOf(state.content);
    const workJson = JSON.stringify(work);
    if (workJson !== state.lastWork) {
      events.push({ type: 'work_snapshot', messageId: state.messageId, blocks: work });
      state.lastWork = workJson;
    }
    if (terminal) events.push(terminal);
    if (events.length) emit(events);
  }

  function schedule(state) {
    if (state.timer) return;
    state.timer = setTimer(() => {
      state.timer = null;
      if (message === state) flush(state);
    }, SNAPSHOT_INTERVAL_MS);
  }

  function endMessage(final) {
    const state = message;
    if (!state) return;
    message = null;
    if (state.timer) { clearTimer(state.timer); state.timer = null; }
    state.content = final?.content ?? state.content;
    const aborted = final?.stopReason === 'aborted' || final?.stopReason === 'error';
    const tools = hasToolCall(state.content);
    flush(state, {
      type: aborted || tools ? 'assistant_cancel' : 'assistant_end',
      messageId: state.messageId,
      ...(tools && !aborted ? { willContinue: true } : {}),
    });
  }

  function handle(event) {
    switch (event.type) {
      case 'run_start':
        emit([{ type: 'agent_start' }]);
        break;
      case 'run_end':
        endMessage();
        emit([{ type: 'agent_end' }]);
        break;
      case 'message_start':
        if (event.message?.role !== 'assistant') break;
        endMessage();
        message = { messageId: randomUUID(), content: structuredClone(event.message.content || []), timer: null, lastText: '', lastWork: '[]' };
        break;
      case 'message_update':
        if (!message) break;
        for (const change of event.changes || []) {
          message.content = change.type === 'message' ? structuredClone(change.message.content || []) : applyChange(message.content, change);
        }
        schedule(message);
        break;
      case 'message_end': {
        const final = event.entry?.model?.[0];
        if (final?.role === 'assistant') endMessage(final);
        break;
      }
      case 'tool_execution_start':
        toolOutput.set(event.toolCallId, '');
        emit([{ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: sanitizeArgs(event.args) }]);
        break;
      case 'tool_execution_update': {
        let output = toolOutput.get(event.toolCallId) || '';
        if (event.output && 'set' in event.output) output = event.output.set;
        else if (event.output) output = output.slice(event.output.trimStart || 0) + (event.output.append || '');
        output = clip(output, MAX_OUTPUT_CHARS);
        toolOutput.set(event.toolCallId, output);
        emit([{ type: 'tool_execution_update', toolCallId: event.toolCallId, toolName: event.toolName, partialResult: { content: [{ type: 'text', text: output }] } }]);
        break;
      }
      case 'tool_execution_end': {
        toolOutput.delete(event.toolCallId);
        const result = event.entry?.model?.[0];
        emit([{
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: { content: [{ type: 'text', text: clip(textOf(result?.content), MAX_OUTPUT_CHARS) }] },
          isError: !!result?.isError || !result,
        }]);
        break;
      }
      default:
        break;
    }
  }

  return { handle, handleBatch: events => { for (const event of events) handle(event); } };
}

export function sessionStateEvent(modelRef) {
  const ref = String(modelRef || '');
  const [provider] = ref.split('/');
  return { type: 'session_state', modelProvider: provider || 'unknown', modelId: ref, modelApi: 'anthropic-messages', serviceTiers: {} };
}

/** Posts events to Feather. Coalesces nothing; batches up to 50 per request. */
export function createBridgeClient({ url, token, fetchImpl = globalThis.fetch, onError = () => {} }) {
  const queue = [];
  let delivering = false;
  let closed = false;

  async function deliver() {
    if (!url || !token || delivering) return;
    delivering = true;
    try {
      while (queue.length && !closed) {
        const batch = [];
        let bytes = 32;
        while (queue.length && batch.length < 50) {
          const size = Buffer.byteLength(JSON.stringify(queue[0])) + 1;
          if (size > MAX_POST_BYTES) { queue.shift(); continue; }
          if (batch.length && bytes + size > MAX_POST_BYTES) break;
          batch.push(queue.shift());
          bytes += size;
        }
        if (!batch.length) continue;
        try {
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': token },
            body: JSON.stringify({ version: BRIDGE_VERSION, events: batch }),
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) onError(new Error(`bridge HTTP ${response.status}`));
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      delivering = false;
    }
  }

  return {
    post(events) {
      if (closed || !url || !token) return;
      queue.push(...events);
      if (queue.length > 500) queue.splice(0, queue.length - 500);
      void deliver();
    },
    close() { closed = true; },
    get pending() { return queue.length; },
  };
}
