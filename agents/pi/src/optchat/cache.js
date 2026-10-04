// Cache breakpoints inside the view (spec §8), for Anthropic-wire requests.
//
// pi-ai marks the system prompt and the request's last block. The view is the
// first text block of the turn's first user message. Cut it at the last line
// end before 50,000, 80,000 and 100,000 characters (a mark past its end is
// skipped) and mark each piece, so the next turn reads the longest marked
// piece that is still identical. Anthropic allows 4 breakpoints per request;
// when there would be more, the earliest marks outside the view go first:
// the view's first mark covers the tools and system prompt anyway.
export const MARKS = [50_000, 80_000, 100_000];
const MAX_BREAKPOINTS = 4;

export function isViewText(text) {
  return typeof text === 'string' && text.startsWith('<chat>\n') && text.endsWith('</chat>');
}

/** Cut the view into pieces at the last line end before each mark. */
export function splitView(text, marks = MARKS) {
  const pieces = [];
  let from = 0;
  for (const mark of marks) {
    if (mark >= text.length) break;
    const cut = text.lastIndexOf('\n', mark - 1) + 1;
    if (cut <= from) continue;
    pieces.push(text.slice(from, cut));
    from = cut;
  }
  if (from < text.length) pieces.push(text.slice(from));
  return pieces;
}

/** Rewrite an Anthropic Messages payload in place; returns it. */
export function markViewPayload(payload, marks = MARKS) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  let found = false;
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const index = message.content.findIndex(block => block?.type === 'text' && isViewText(block.text));
    if (index < 0) continue;
    const block = message.content[index];
    const pieces = splitView(block.text, marks);
    if (pieces.length < 2) return payload; // shorter than the first mark: no marks (spec §8)
    // Every piece that ends at a cut gets a mark. The rest, after the last
    // cut, changes from turn to turn and is left unmarked.
    const { cache_control: kept, ...plain } = block;
    const replacement = pieces.map((text, k) => (k < pieces.length - 1
      ? { ...plain, text, cache_control: { type: 'ephemeral' } }
      : { ...plain, text, ...(kept ? { cache_control: kept } : {}) }));
    message.content.splice(index, 1, ...replacement);
    found = true;
    break;
  }
  if (!found) return payload;
  // Keep at most MAX_BREAKPOINTS: drop marks outside the messages first, oldest first.
  const holders = [];
  for (const block of Array.isArray(payload.system) ? payload.system : []) if (block?.cache_control) holders.push(block);
  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) if (tool?.cache_control) holders.push(tool);
  const inMessages = [];
  for (const message of payload.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) if (block?.cache_control) inMessages.push(block);
  }
  let total = holders.length + inMessages.length;
  for (const holder of holders) {
    if (total <= MAX_BREAKPOINTS) break;
    delete holder.cache_control;
    total--;
  }
  return payload;
}

/** Wrap a pi-ai API so every request marks its view. */
export function withViewMarks(api) {
  const wrap = fn => (model, context, options = {}) => fn(model, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const prior = options.onPayload ? await options.onPayload(payload, requestModel) : undefined;
      return markViewPayload(prior ?? payload);
    },
  });
  return { ...api, stream: wrap(api.stream), streamSimple: wrap(api.streamSimple) };
}
